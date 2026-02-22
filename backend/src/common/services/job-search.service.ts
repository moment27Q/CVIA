import { Injectable } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';

export interface MatchedJob {
  title: string;
  company: string;
  location: string;
  source: string;
  url: string;
  tags: string[];
  score: number;
  publishedAt: string;
  publishedTs: number;
}

interface SourceConfig {
  source: string;
  domainHint: string;
  siteQuery: string;
  peruNative: boolean;
}

@Injectable()
export class JobSearchService {
  private readonly sources: SourceConfig[] = [
    { source: 'Computrabajo', domainHint: 'pe.computrabajo.com', siteQuery: 'site:pe.computrabajo.com', peruNative: true },
    { source: 'Indeed', domainHint: 'pe.indeed.com', siteQuery: 'site:pe.indeed.com', peruNative: true },
    { source: 'Bumeran', domainHint: 'bumeran.com.pe', siteQuery: 'site:bumeran.com.pe', peruNative: true },
    { source: 'LinkedIn', domainHint: 'linkedin.com/jobs', siteQuery: 'site:linkedin.com/jobs', peruNative: false },
    { source: 'Portal del Empleo', domainHint: 'empleosperu.gob.pe', siteQuery: 'site:empleosperu.gob.pe', peruNative: true },
  ];

  async searchPublicJobs(keywords: string[], location?: string): Promise<MatchedJob[]> {
    const cleanedKeywords = this.cleanKeywords(keywords);
    const seeds = cleanedKeywords.slice(0, 3);
    const defaultSeeds = seeds.length ? seeds : ['practicante', 'asistente', 'analista'];

    const locationText = (location || 'Peru').trim();
    const queries = this.buildQueries(defaultSeeds, locationText);

    const byQuery = await Promise.all(queries.map((q) => this.searchDuckDuckGo(q.query, q.source)));
    const merged = byQuery.flat();

    const dedup = new Map<string, MatchedJob>();
    for (const job of merged) {
      if (!job.url) continue;
      const key = `${job.source}|${job.url}`;
      if (!dedup.has(key)) dedup.set(key, job);
    }

    const all = [...dedup.values()];
    const peruOnly = all.filter((job) => this.isPeruJob(job, locationText));
    const base = peruOnly.length ? peruOnly : all;

    const ranked = base
      .map((job) => ({ ...job, score: this.scoreJob(job, cleanedKeywords, locationText) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 120);

    const fallback = this.buildPortalSearchFallback(cleanedKeywords, locationText);
    return this.mergeAndDedupe([...ranked, ...fallback]).slice(0, 220);
  }

  private buildQueries(seeds: string[], locationText: string): Array<{ query: string; source: SourceConfig }> {
    const out: Array<{ query: string; source: SourceConfig }> = [];

    for (const source of this.sources) {
      for (const seed of seeds) {
        out.push({ query: `${source.siteQuery} empleo ${locationText} ${seed}`, source });
      }
      out.push({ query: `${source.siteQuery} trabajo peru`, source });
      out.push({ query: `${source.siteQuery} ofertas laborales peru`, source });
    }

    return out;
  }

  private async searchDuckDuckGo(query: string, source: SourceConfig): Promise<MatchedJob[]> {
    try {
      const { data } = await axios.get<string>('https://duckduckgo.com/html/', {
        params: { q: query },
        timeout: 15000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
        },
      });

      const $ = cheerio.load(data);
      const jobs: MatchedJob[] = [];

      $('.result').each((_, el) => {
        const title = this.clean($(el).find('.result__a').first().text()) || 'Vacante';
        const href = this.normalizeUrl($(el).find('.result__a').first().attr('href') || '');
        const snippet = this.clean($(el).find('.result__snippet').first().text());
        const published = this.parsePublishedFromSnippet(snippet);

        if (!href.toLowerCase().includes(source.domainHint.toLowerCase())) return;

        jobs.push({
          title,
          company: this.extractCompany(title, snippet),
          location: this.extractLocation(snippet, source),
          source: source.source,
          url: href,
          tags: this.extractTags(`${title} ${snippet}`),
          score: 0,
          publishedAt: published.label,
          publishedTs: published.ts,
        });
      });

      return jobs.slice(0, 14);
    } catch {
      return [];
    }
  }

  private cleanKeywords(keywords: string[]): string[] {
    const noise = new Set(['proyecto', 'titulo', 'descripcion', 'descripci', 'club', 'deportivo', 'intermedio', '2022']);
    const cleaned = keywords
      .map((k) => this.normalize(k))
      .filter((k) => k && k.length >= 3 && !noise.has(k));

    return [...new Set(cleaned)];
  }

  private isPeruJob(job: MatchedJob, locationText: string): boolean {
    const geo = this.normalize(`${job.title} ${job.location} ${job.tags.join(' ')}`);

    if (locationText.toLowerCase() === 'peru') {
      if (job.source === 'Computrabajo' || job.source === 'Indeed' || job.source === 'Bumeran' || job.source === 'Portal del Empleo') {
        return true;
      }
      const peruTokens = ['peru', 'lima', 'arequipa', 'trujillo', 'cusco', 'piura', 'chiclayo'];
      return peruTokens.some((t) => geo.includes(t));
    }

    return geo.includes(this.normalize(locationText));
  }

  private scoreJob(job: MatchedJob, keywords: string[], locationText: string): number {
    const haystack = this.normalize(`${job.title} ${job.company} ${job.location} ${job.tags.join(' ')}`);
    const needle = keywords.map((k) => this.normalize(k)).filter(Boolean);

    let score = 0;
    for (const k of needle) {
      if (haystack.includes(k)) score += 12;
    }

    const loc = this.normalize(locationText);
    if (loc && haystack.includes(loc)) score += 8;
    if (haystack.includes('peru') || haystack.includes('lima')) score += 4;
    if (job.source === 'Computrabajo' || job.source === 'Bumeran' || job.source === 'Indeed') score += 2;
    return score;
  }

  private extractTags(text: string): string[] {
    const blacklist = new Set(['empleo', 'trabajo', 'peru', 'lima', 'remote', 'remoto', 'titulo', 'descripcion']);
    const words = this.normalize(text).match(/[a-z0-9+#.]{4,}/g) || [];
    const freq = new Map<string, number>();

    for (const word of words) {
      if (blacklist.has(word)) continue;
      freq.set(word, (freq.get(word) || 0) + 1);
    }

    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([w]) => w);
  }

  private extractCompany(title: string, snippet: string): string {
    const joined = `${title} | ${snippet}`;
    const byDash = joined.split('-').map((x) => this.clean(x));
    if (byDash.length > 1 && byDash[1]) return byDash[1].slice(0, 80);
    return 'Empresa no detectada';
  }

  private extractLocation(snippet: string, source: SourceConfig): string {
    const normalized = this.normalize(snippet);
    const cities = ['lima', 'arequipa', 'trujillo', 'cusco', 'piura', 'chiclayo'];
    for (const city of cities) {
      if (normalized.includes(city)) return `${city[0].toUpperCase()}${city.slice(1)}, Peru`;
    }
    if (normalized.includes('peru') || source.peruNative) return 'Peru';
    return 'Peru (no especificado)';
  }

  private normalizeUrl(url: string): string {
    const trimmed = this.clean(url);
    if (!trimmed) return '';
    if (trimmed.startsWith('http')) return trimmed;

    const match = trimmed.match(/[?&]uddg=([^&]+)/i);
    if (match?.[1]) {
      try {
        const decoded = decodeURIComponent(match[1]);
        return decoded.startsWith('http') ? decoded : '';
      } catch {
        return '';
      }
    }

    return '';
  }

  private normalize(value: string): string {
    return value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private clean(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  private buildPortalSearchFallback(keywords: string[], locationText: string): MatchedJob[] {
    const location = locationText || 'Peru';
    const seeds = keywords.length ? keywords.slice(0, 20) : ['practicante', 'analista', 'asistente', 'python'];
    const sources = [
      'Computrabajo',
      'Indeed',
      'Bumeran',
      'LinkedIn',
      'Portal del Empleo',
    ] as const;

    const entries: MatchedJob[] = [];
    for (const seed of seeds) {
      for (const source of sources) {
        const url = this.buildSourceSearchUrl(source, seed, location);
        entries.push({
          title: `Buscar "${seed}" en ${source} (${location})`,
          company: source,
          location,
          source,
          url,
          tags: [seed, ...seeds.slice(0, 4)],
          score: 30,
          publishedAt: 'Sin fecha',
          publishedTs: 0,
        });
      }
    }

    return entries;
  }

  private buildSourceSearchUrl(source: string, keyword: string, location: string): string {
    const q = encodeURIComponent(keyword);
    const l = encodeURIComponent(location);

    if (source === 'Indeed') {
      return `https://pe.indeed.com/jobs?q=${q}&l=${l}`;
    }
    if (source === 'LinkedIn') {
      return `https://www.linkedin.com/jobs/search/?keywords=${q}&location=${l}`;
    }
    if (source === 'Computrabajo') {
      return `https://www.bing.com/search?q=${encodeURIComponent(`site:pe.computrabajo.com ${keyword} ${location}`)}`;
    }
    if (source === 'Bumeran') {
      return `https://www.bing.com/search?q=${encodeURIComponent(`site:bumeran.com.pe ${keyword} ${location}`)}`;
    }
    return `https://www.bing.com/search?q=${encodeURIComponent(`site:empleosperu.gob.pe ${keyword} ${location}`)}`;
  }

  private mergeAndDedupe(items: MatchedJob[]): MatchedJob[] {
    const map = new Map<string, MatchedJob>();
    for (const item of items) {
      if (!item.url) continue;
      const key = `${item.source}|${item.url}`;
      if (!map.has(key)) {
        map.set(key, item);
      }
    }
    return [...map.values()].sort((a, b) => {
      const byDate = b.publishedTs - a.publishedTs;
      if (byDate !== 0) return byDate;
      return b.score - a.score;
    });
  }

  private parsePublishedFromSnippet(snippet: string): { ts: number; label: string } {
    const text = this.normalize(snippet);
    const now = Date.now();

    const agoHour = text.match(/hace\s+(\d+)\s+hora[s]?/) || text.match(/(\d+)\s+hour[s]?\s+ago/);
    if (agoHour) {
      const n = Number(agoHour[1] || agoHour[2] || 0);
      const ts = now - n * 3600 * 1000;
      return { ts, label: `${n} h` };
    }

    const agoDay = text.match(/hace\s+(\d+)\s+dia[s]?/) || text.match(/(\d+)\s+day[s]?\s+ago/);
    if (agoDay) {
      const n = Number(agoDay[1] || agoDay[2] || 0);
      const ts = now - n * 24 * 3600 * 1000;
      return { ts, label: `${n} d` };
    }

    const agoWeek = text.match(/hace\s+(\d+)\s+semana[s]?/) || text.match(/(\d+)\s+week[s]?\s+ago/);
    if (agoWeek) {
      const n = Number(agoWeek[1] || agoWeek[2] || 0);
      const ts = now - n * 7 * 24 * 3600 * 1000;
      return { ts, label: `${n} sem` };
    }

    const iso = snippet.match(/\b(20\d{2})[-\/](\d{1,2})[-\/](\d{1,2})\b/);
    if (iso) {
      const y = Number(iso[1]);
      const m = Number(iso[2]);
      const d = Number(iso[3]);
      const dt = new Date(y, m - 1, d).getTime();
      if (!Number.isNaN(dt)) {
        return { ts: dt, label: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
      }
    }

    return { ts: 0, label: 'Sin fecha' };
  }
}
