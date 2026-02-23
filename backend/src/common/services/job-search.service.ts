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

export interface JobProviderStatus {
  provider: string;
  enabled: boolean;
  success: boolean;
  jobs: number;
  error?: string;
}

export interface JobSearchResult {
  jobs: MatchedJob[];
  providers: JobProviderStatus[];
}

export interface ExperienceProfile {
  years: number;
  level: 'intern' | 'junior' | 'mid' | 'senior';
  prefersInternships: boolean;
  seniorityTerms: string[];
}

interface SourceConfig {
  source: string;
  domainHint: string;
  siteQuery: string;
}

@Injectable()
export class JobSearchService {
  private readonly providerLimit = 25;
  private readonly rapidApiKey = (process.env.RAPIDAPI_KEY || '').trim();
  private readonly rapidApiHost = process.env.RAPIDAPI_HOST || 'linkedin-job-search-api.p.rapidapi.com';
  private readonly rapidApiBaseUrl = process.env.RAPIDAPI_BASE_URL || `https://${this.rapidApiHost}`;

  private readonly theirStackApiKey = (process.env.THEIRSTACK_API_KEY || '').trim();
  private readonly theirStackBaseUrl = process.env.THEIRSTACK_BASE_URL || 'https://api.theirstack.com/v1';
  private readonly coreSignalApiKey = (process.env.CORESIGNAL_API_KEY || '').trim();
  private readonly coreSignalBaseUrl = process.env.CORESIGNAL_BASE_URL || 'https://api.coresignal.com/cdapi/v2';

  private readonly sources: SourceConfig[] = [
    { source: 'LinkedIn', domainHint: 'linkedin.com/jobs', siteQuery: 'site:linkedin.com/jobs' },
    { source: 'Indeed', domainHint: 'indeed.', siteQuery: 'site:indeed.' },
    { source: 'Computrabajo', domainHint: 'computrabajo.', siteQuery: 'site:computrabajo.' },
    { source: 'Bumeran', domainHint: 'bumeran.', siteQuery: 'site:bumeran.' },
    { source: 'Glassdoor', domainHint: 'glassdoor.', siteQuery: 'site:glassdoor.' },
  ];

  async searchPublicJobs(
    keywords: string[],
    location?: string,
    country?: string,
    desiredRole?: string,
    experience?: ExperienceProfile,
  ): Promise<JobSearchResult> {
    const cleanedKeywords = this.cleanKeywords(keywords);
    const enrichedKeywords = this.enrichKeywordsWithExperience(cleanedKeywords, experience);
    const seeds = enrichedKeywords.slice(0, 3);
    const defaultSeeds = seeds.length ? seeds : ['practicante', 'analista', 'asistente'];

    const countryText = this.resolveCountry(country, location);
    const cityOrRegion = (location || '').trim();
    const locationText = cityOrRegion ? `${cityOrRegion}, ${countryText}` : countryText;

    const queries = this.buildQueries(defaultSeeds, locationText);
    const [theirStackResult, coreSignalResult, byQuery] = await Promise.all([
      this.searchTheirStackJobs(enrichedKeywords, countryText, cityOrRegion, desiredRole, experience),
      this.searchCoreSignalJobs(enrichedKeywords, countryText, cityOrRegion, desiredRole, experience),
      Promise.all(queries.map((q) => this.searchDuckDuckGo(q.query, q.source, countryText))),
    ]);

    const merged = [...theirStackResult.jobs, ...coreSignalResult.jobs, ...byQuery.flat()];
    const dedup = this.mergeAndDedupe(merged);
    const filtered = dedup.filter((job) => this.isJobInCountry(job, countryText, cityOrRegion));
    const base = filtered.length ? filtered : dedup;

    const ranked = base
      .map((job) => ({ ...job, score: this.scoreJob(job, enrichedKeywords, countryText, cityOrRegion, experience) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 180);

    const fallback = this.buildPortalSearchFallback(enrichedKeywords, countryText, cityOrRegion);
    const finalJobs = this.mergeAndDedupe([...ranked, ...fallback]).slice(0, 250);

    const providers: JobProviderStatus[] = [
      theirStackResult.status,
      coreSignalResult.status,
      {
        provider: 'Public Scraping',
        enabled: true,
        success: byQuery.flat().length > 0,
        jobs: byQuery.flat().length,
        error: byQuery.flat().length > 0 ? undefined : 'Sin resultados (bloqueo/rate limit del buscador o filtros muy estrictos)',
      },
    ];

    return {
      jobs: finalJobs,
      providers,
    };
  }

  private buildQueries(seeds: string[], locationText: string): Array<{ query: string; source: SourceConfig }> {
    const out: Array<{ query: string; source: SourceConfig }> = [];

    for (const source of this.sources) {
      for (const seed of seeds) {
        out.push({ query: `${source.siteQuery} empleo ${locationText} ${seed}`, source });
        out.push({ query: `${source.siteQuery} jobs ${locationText} ${seed}`, source });
      }
    }

    return out;
  }

  private async searchRapidApiJobs(
    seeds: string[],
    keywords: string[],
    locationText: string,
    desiredRole?: string,
  ): Promise<{ jobs: MatchedJob[]; status: JobProviderStatus }> {
    if (!this.rapidApiKey) {
      return {
        jobs: [],
        status: {
          provider: 'RapidAPI',
          enabled: false,
          success: false,
          jobs: 0,
          error: 'RAPIDAPI_KEY no configurada',
        },
      };
    }

    const endpoints = this.buildRapidApiEndpoints();
    const titleCandidates = [
      (desiredRole || '').trim(),
      ...keywords.filter((k) => k.length >= 4),
      ...seeds,
      'analyst',
    ]
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 3);

    try {
      const responses = [];
      // Keep RapidAPI load very low: one successful query (limit 25) per request.
      for (const titleFilter of titleCandidates.slice(0, 1)) {
        for (const endpoint of endpoints) {
          try {
            const response = await axios.get(endpoint, {
              timeout: 18000,
              params: {
                limit: 25,
                offset: 0,
                title_filter: titleFilter,
                location_filter: locationText,
                description_type: 'text',
              },
              headers: {
                'x-rapidapi-key': this.rapidApiKey,
                'x-rapidapi-host': this.rapidApiHost,
              },
            });
            responses.push(response);
            break;
          } catch (endpointError) {
            if (axios.isAxiosError(endpointError) && endpointError.response?.status === 429) {
              continue;
            }
            throw endpointError;
          }
        }
        if (responses.length) break;
      }

      if (!responses.length) {
        return {
          jobs: [],
          status: {
            provider: 'RapidAPI',
            enabled: true,
            success: false,
            jobs: 0,
            error: '429 quota/rate limit',
          },
        };
      }

      const jobs: MatchedJob[] = [];

      for (const response of responses) {
        const records = this.extractRapidApiRecords(response.data);
        for (const record of records) {
          const job = this.mapRapidRecord(record);
          if (job) jobs.push(job);
        }
      }

      const deduped = this.mergeAndDedupe(jobs).slice(0, 140);
      return {
        jobs: deduped,
        status: {
          provider: 'RapidAPI',
          enabled: true,
          success: deduped.length > 0,
          jobs: deduped.length,
        },
      };
    } catch (error) {
      return {
        jobs: [],
        status: {
          provider: 'RapidAPI',
          enabled: true,
          success: false,
          jobs: 0,
          error: this.readAxiosError(error),
        },
      };
    }
  }

  private async searchTheirStackJobs(
    keywords: string[],
    countryText: string,
    cityOrRegion: string,
    desiredRole?: string,
    experience?: ExperienceProfile,
  ): Promise<{ jobs: MatchedJob[]; status: JobProviderStatus }> {
    if (!this.theirStackApiKey) {
      return {
        jobs: [],
        status: {
          provider: 'TheirStack',
          enabled: false,
          success: false,
          jobs: 0,
          error: 'THEIRSTACK_API_KEY no configurada',
        },
      };
    }

    const endpoints = this.buildTheirStackEndpoints();
    const keywordBatch = keywords.slice(0, 12);
    const role = (desiredRole || '').trim();
    const titleTerms = role ? [role, ...((experience?.seniorityTerms || []).slice(0, 3))] : (experience?.seniorityTerms || []).slice(0, 4);
    const countryCode = this.resolveCountryCode(countryText);
    const city = cityOrRegion.trim();

    const requestBodies: Record<string, unknown>[] = [
      {
        job_country_code_or: countryCode ? [countryCode] : undefined,
        job_title_or: titleTerms.length ? titleTerms : undefined,
        job_description_contains_or: keywordBatch,
        posted_at_max_age_days: 14,
        limit: 25,
        order_by: [{ desc: true, field: 'date_posted' }],
        blur_company_data: false,
      },
    ];

    if (keywordBatch.length >= 6) {
      requestBodies.push({
        job_country_code_or: countryCode ? [countryCode] : undefined,
        job_title_or: keywordBatch.slice(0, 4),
        job_description_contains_or: keywordBatch.slice(4, 12),
        posted_at_max_age_days: 14,
        limit: 25,
        order_by: [{ desc: true, field: 'date_posted' }],
        blur_company_data: false,
      });
    }

    if (city) {
      requestBodies.push({
        job_country_code_or: countryCode ? [countryCode] : undefined,
        job_location_pattern_or: [city],
        job_description_contains_or: keywordBatch,
        posted_at_max_age_days: 14,
        limit: 25,
        order_by: [{ desc: true, field: 'date_posted' }],
        blur_company_data: false,
      });
    }

    try {
      const responses = [];
      let lastError: unknown = null;
      let lastEndpoint = '';

      for (const endpoint of endpoints) {
        try {
          const response = await axios.post(endpoint, this.compactObject(requestBodies[0]), {
            timeout: 20000,
            headers: {
              Authorization: `Bearer ${this.theirStackApiKey}`,
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
          });
          responses.push(response);
        } catch (error) {
          lastError = error;
          lastEndpoint = endpoint;
        }

        if (responses.length) {
          for (const body of requestBodies.slice(1)) {
            try {
              const response = await axios.post(endpoint, this.compactObject(body), {
                timeout: 20000,
                headers: {
                  Authorization: `Bearer ${this.theirStackApiKey}`,
                  Accept: 'application/json',
                  'Content-Type': 'application/json',
                },
              });
              responses.push(response);
            } catch {
              // Ignore secondary query failures; keep primary success.
            }
          }
          break;
        }
      }

      if (!responses.length && lastError) {
        throw this.wrapEndpointError(lastError, lastEndpoint);
      }

      const jobs: MatchedJob[] = [];
      for (const response of responses) {
        const records = this.extractTheirStackRecords(response.data);
        for (const record of records) {
          const job = this.mapTheirStackRecord(record);
          if (job) jobs.push(job);
        }
      }
      const deduped = this.mergeAndDedupe(jobs).slice(0, 180);
      return {
        jobs: deduped,
        status: {
          provider: 'TheirStack',
          enabled: true,
          success: deduped.length > 0,
          jobs: deduped.length,
        },
      };
    } catch (error) {
      return {
        jobs: [],
        status: {
          provider: 'TheirStack',
          enabled: true,
          success: false,
          jobs: 0,
          error: this.readAxiosError(error),
        },
      };
    }
  }

  private async searchCoreSignalJobs(
    keywords: string[],
    countryText: string,
    cityOrRegion: string,
    desiredRole?: string,
    experience?: ExperienceProfile,
  ): Promise<{ jobs: MatchedJob[]; status: JobProviderStatus }> {
    if (!this.coreSignalApiKey) {
      return {
        jobs: [],
        status: {
          provider: 'CoreSignal',
          enabled: false,
          success: false,
          jobs: 0,
          error: 'CORESIGNAL_API_KEY no configurada',
        },
      };
    }

    const base = this.coreSignalBaseUrl.replace(/\/+$/, '');
    const searchEndpoint = `${base}/job_base/search/filter`;
    const collectEndpointBase = `${base}/job_base/collect`;

    const terms = [
      (desiredRole || '').trim(),
      ...(experience?.seniorityTerms || []),
      ...keywords.filter((k) => k.length >= 4),
    ]
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 6);

    try {
      const keywordDescription = keywords.slice(0, 10).join(' OR ');
      const location = cityOrRegion.trim() ? `${cityOrRegion.trim()}, ${countryText}` : countryText;
      const searchBodies: Record<string, unknown>[] = [
        {
          application_active: true,
          deleted: false,
          title: terms[0] || undefined,
          keyword_description: keywordDescription || undefined,
          location: location || undefined,
          country: countryText || undefined,
        },
        {
          application_active: true,
          deleted: false,
          title: terms[0] || undefined,
          keyword_description: keywordDescription || undefined,
          country: countryText || undefined,
        },
        {
          application_active: true,
          deleted: false,
          keyword_description: keywordDescription || undefined,
          country: countryText || undefined,
        },
        {
          application_active: true,
          deleted: false,
          keyword_description: keywordDescription || undefined,
        },
      ].map((body) => this.compactObject(body));

      let ids: string[] = [];
      for (const body of searchBodies) {
        const searchResponse = await axios.post(searchEndpoint, body, {
          timeout: 20000,
          headers: {
            apikey: this.coreSignalApiKey,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
        });

        ids = this.extractCoreSignalIds(searchResponse.data).slice(0, this.providerLimit);
        if (ids.length > 0) break;
      }

      if (!ids.length) {
        return {
          jobs: [],
          status: {
            provider: 'CoreSignal',
            enabled: true,
            success: false,
            jobs: 0,
            error: '0 IDs returned by search/filter (after broad retries)',
          },
        };
      }

      const detailResponses = await Promise.all(
        ids.map((id) =>
          axios.get(`${collectEndpointBase}/${encodeURIComponent(id)}`, {
            timeout: 20000,
            headers: {
              apikey: this.coreSignalApiKey,
              Accept: 'application/json',
            },
          }),
        ),
      );

      const jobs: MatchedJob[] = [];
      for (const response of detailResponses) {
        const record = response.data;
        if (!record || typeof record !== 'object') continue;
        const mapped = this.mapCoreSignalRecord(record as Record<string, unknown>);
        if (mapped) jobs.push(mapped);
      }

      const deduped = this.mergeAndDedupe(jobs).slice(0, this.providerLimit);
      return {
        jobs: deduped,
        status: {
          provider: 'CoreSignal',
          enabled: true,
          success: deduped.length > 0,
          jobs: deduped.length,
        },
      };
    } catch (error) {
      return {
        jobs: [],
        status: {
          provider: 'CoreSignal',
          enabled: true,
          success: false,
          jobs: 0,
          error: this.readAxiosError(error),
        },
      };
    }
  }

  private readAxiosError(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const raw = error.response?.data;
      let text = '';
      if (typeof raw === 'string') text = raw;
      else if (raw && typeof raw === 'object') {
        const obj = raw as Record<string, unknown>;
        text =
          (typeof obj.message === 'string' && obj.message) ||
          (typeof obj.error === 'string' && obj.error) ||
          JSON.stringify(raw);
      }
      return `${status || 'request_failed'} ${text}`.trim();
    }
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return 'request_failed';
  }

  private buildTheirStackEndpoints(): string[] {
    const base = this.theirStackBaseUrl.replace(/\/+$/, '');
    if (base.endsWith('/v1')) {
      return [`${base}/jobs/search`];
    }
    return [`${base}/v1/jobs/search`, `${base}/jobs/search`];
  }

  private buildRapidApiEndpoints(): string[] {
    const base = this.rapidApiBaseUrl.replace(/\/+$/, '');
    if (this.rapidApiHost.includes('linkedin-job-search-api')) {
      return [`${base}/active-jb-24h`, `${base}/active-jb-7d`];
    }
    return [`${base}/active-ats-24h`, `${base}/active-ats-7d`, `${base}/active-jb-24h`, `${base}/active-jb-7d`];
  }

  private wrapEndpointError(error: unknown, endpoint: string): unknown {
    if (!axios.isAxiosError(error)) return error;
    const status = error.response?.status;
    const data = error.response?.data;
    const message =
      typeof data === 'string'
        ? data
        : data && typeof data === 'object'
          ? JSON.stringify(data)
          : error.message;
    return new Error(`${status || 'request_failed'} ${endpoint} ${message}`.trim());
  }

  private compactObject(input: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      out[key] = value;
    }
    return out;
  }

  private extractRapidApiRecords(payload: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(payload)) {
      return payload.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
    }

    if (!payload || typeof payload !== 'object') {
      return [];
    }

    const candidate = payload as Record<string, unknown>;
    const nested = ['data', 'results', 'jobs', 'items'];
    for (const key of nested) {
      const value = candidate[key];
      if (Array.isArray(value)) {
        return value.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
      }
    }

    return [];
  }

  private mapRapidRecord(record: Record<string, unknown>): MatchedJob | null {
    const title = this.pickString(record, ['title', 'job_title', 'position', 'name']) || 'Vacante';
    const company = this.pickString(record, ['organization', 'company', 'company_name', 'hiring_company']) || 'Empresa no detectada';
    const location = this.pickString(record, ['location', 'candidate_required_location', 'city', 'country']) || 'No especificado';
    const url = this.normalizeUrl(this.pickString(record, ['url', 'job_url', 'link', 'job_link', 'apply_url']) || '');
    if (!url) return null;

    const description =
      this.pickString(record, ['description', 'job_description', 'summary', 'snippet']) || '';
    const rawDate = this.pickString(record, ['date_posted', 'created_at', 'published_at', 'publication_date', 'posted_at', 'date']);
    const published = this.parsePublished(rawDate);

    return {
      title: this.clean(title),
      company: this.clean(company),
      location: this.clean(location),
      source: 'RapidAPI',
      url,
      tags: this.extractTags(`${title} ${company} ${location} ${description}`),
      score: 0,
      publishedAt: published.label,
      publishedTs: published.ts,
    };
  }

  private extractTheirStackRecords(payload: unknown): Array<Record<string, unknown>> {
    if (!payload || typeof payload !== 'object') return [];
    const candidate = payload as Record<string, unknown>;
    const nested = ['data', 'results', 'jobs', 'items'];
    for (const key of nested) {
      const value = candidate[key];
      if (Array.isArray(value)) {
        return value.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
      }
    }
    return [];
  }

  private extractCoreSignalIds(payload: unknown): string[] {
    if (!Array.isArray(payload)) return [];
    return payload
      .map((id) => String(id || '').trim())
      .filter(Boolean);
  }

  private mapTheirStackRecord(record: Record<string, unknown>): MatchedJob | null {
    const title = this.pickString(record, ['job_title', 'title', 'position', 'name']) || 'Vacante';
    const company = this.pickString(record, ['company_name', 'company', 'organization']) || 'Empresa no detectada';
    const location = this.pickString(record, ['job_location', 'location', 'city', 'country']) || 'No especificado';
    const url = this.normalizeUrl(
      this.pickString(record, ['final_url', 'url', 'job_url', 'apply_url', 'job_apply_link']),
    );
    if (!url) return null;

    const description = this.pickString(record, ['job_description', 'description', 'snippet']);
    const rawDate = this.pickString(record, ['date_posted', 'discovered_at', 'created_at', 'posted_at']);
    const published = this.parsePublished(rawDate);

    return {
      title: this.clean(title),
      company: this.clean(company),
      location: this.clean(location),
      source: 'TheirStack',
      url,
      tags: this.extractTags(`${title} ${company} ${location} ${description}`),
      score: 0,
      publishedAt: published.label,
      publishedTs: published.ts,
    };
  }

  private mapCoreSignalRecord(record: Record<string, unknown>): MatchedJob | null {
    const title = this.pickString(record, ['title', 'job_title', 'name']) || 'Vacante';
    const company = this.pickString(record, ['company_name', 'company', 'organization']) || 'Empresa no detectada';
    const location = this.pickString(record, ['location', 'city', 'country']) || 'No especificado';
    const url = this.normalizeUrl(this.pickString(record, ['url', 'job_url', 'apply_url', 'job_link']));
    if (!url) return null;

    const description = this.pickString(record, ['description', 'job_description']);
    const rawDate = this.pickString(record, ['posted', 'date_posted', 'created_at', 'updated']);
    const published = this.parsePublished(rawDate);

    return {
      title: this.clean(title),
      company: this.clean(company),
      location: this.clean(location),
      source: 'CoreSignal',
      url,
      tags: this.extractTags(`${title} ${company} ${location} ${description}`),
      score: 0,
      publishedAt: published.label,
      publishedTs: published.ts,
    };
  }

  private pickString(record: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return '';
  }

  private async searchDuckDuckGo(query: string, source: SourceConfig, countryText: string): Promise<MatchedJob[]> {
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

        if (!href) return;
        if (!href.toLowerCase().includes(source.domainHint.toLowerCase())) return;

        jobs.push({
          title,
          company: this.extractCompany(title, snippet),
          location: this.extractLocation(snippet, countryText),
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

  private enrichKeywordsWithExperience(keywords: string[], experience?: ExperienceProfile): string[] {
    if (!experience) return keywords;
    const extras = experience.seniorityTerms || [];
    return [...new Set([...keywords, ...extras])];
  }

  private resolveCountry(country?: string, location?: string): string {
    const value = (country || '').trim();
    if (value) return value;

    const locationValue = (location || '').trim();
    if (!locationValue) return 'Peru';

    const normalized = this.normalize(locationValue);
    if (normalized.includes('peru')) return 'Peru';
    if (normalized.includes('mexico')) return 'Mexico';
    if (normalized.includes('argentina')) return 'Argentina';
    if (normalized.includes('chile')) return 'Chile';
    if (normalized.includes('colombia')) return 'Colombia';
    if (normalized.includes('espana') || normalized.includes('spain')) return 'Spain';
    if (normalized.includes('united states') || normalized.includes('usa') || normalized.includes('estados unidos')) {
      return 'United States';
    }

    return 'Peru';
  }

  private resolveCountryCode(country: string): string {
    const normalized = this.normalize(country);
    if (normalized === 'peru') return 'PE';
    if (normalized === 'mexico') return 'MX';
    if (normalized === 'argentina') return 'AR';
    if (normalized === 'chile') return 'CL';
    if (normalized === 'colombia') return 'CO';
    if (normalized === 'spain' || normalized === 'espana') return 'ES';
    if (normalized === 'united states') return 'US';
    return '';
  }

  private isJobInCountry(job: MatchedJob, countryText: string, cityOrRegion: string): boolean {
    const geo = this.normalize(`${job.title} ${job.location} ${job.tags.join(' ')}`);
    const countryTokens = this.getCountryTokens(countryText);
    const hasCountry = countryTokens.some((token) => geo.includes(token));

    if (cityOrRegion) {
      const cityToken = this.normalize(cityOrRegion);
      if (cityToken && geo.includes(cityToken)) return true;
    }

    if (hasCountry) return true;
    if (job.source === 'RapidAPI' || job.source === 'TheirStack' || job.source === 'CoreSignal') return false;
    return true;
  }

  private getCountryTokens(countryText: string): string[] {
    const normalized = this.normalize(countryText);
    if (normalized === 'peru') return ['peru', 'lima', 'arequipa', 'trujillo', 'cusco', 'piura', 'chiclayo'];
    if (normalized === 'mexico') return ['mexico', 'cdmx', 'guadalajara', 'monterrey', 'puebla'];
    if (normalized === 'argentina') return ['argentina', 'buenos aires', 'cordoba', 'rosario', 'mendoza'];
    if (normalized === 'chile') return ['chile', 'santiago', 'valparaiso', 'concepcion', 'vina del mar'];
    if (normalized === 'colombia') return ['colombia', 'bogota', 'medellin', 'cali', 'barranquilla'];
    if (normalized === 'spain' || normalized === 'espana') return ['spain', 'espana', 'madrid', 'barcelona', 'valencia'];
    if (normalized === 'united states') return ['united states', 'usa', 'us', 'new york', 'california', 'texas', 'florida'];
    return [normalized];
  }

  private scoreJob(
    job: MatchedJob,
    keywords: string[],
    countryText: string,
    cityOrRegion: string,
    experience?: ExperienceProfile,
  ): number {
    const haystack = this.normalize(`${job.title} ${job.company} ${job.location} ${job.tags.join(' ')}`);
    const needle = keywords.map((k) => this.normalize(k)).filter(Boolean);

    let score = 0;
    for (const k of needle) {
      if (haystack.includes(k)) score += 12;
    }

    const countryTokens = this.getCountryTokens(countryText);
    if (countryTokens.some((token) => haystack.includes(token))) score += 8;

    if (cityOrRegion) {
      const cityToken = this.normalize(cityOrRegion);
      if (cityToken && haystack.includes(cityToken)) score += 6;
    }

    const recencyHours = this.getAgeInHours(job.publishedTs);
    if (recencyHours <= 24) score += 14;
    else if (recencyHours <= 72) score += 8;
    else if (recencyHours <= 168) score += 4;

    if (job.source === 'RapidAPI') score += 6;
    if (job.source === 'TheirStack') score += 6;
    if (job.source === 'CoreSignal') score += 6;
    score += this.scoreByExperience(haystack, experience);
    return score;
  }

  private scoreByExperience(haystack: string, experience?: ExperienceProfile): number {
    if (!experience) return 0;

    const entryTokens = ['practicante', 'practica', 'intern', 'junior', 'trainee', 'entry level'];
    const seniorTokens = ['senior', 'lead', 'manager', 'principal', 'head'];

    const hasEntry = entryTokens.some((token) => haystack.includes(token));
    const hasSenior = seniorTokens.some((token) => haystack.includes(token));

    if (experience.prefersInternships) {
      if (hasEntry) return 14;
      if (hasSenior) return -16;
      return 0;
    }

    if (experience.level === 'junior') {
      if (hasEntry) return 8;
      if (hasSenior) return -10;
      return 0;
    }

    if (experience.level === 'senior') {
      if (hasSenior) return 10;
      if (hasEntry) return -8;
      return 0;
    }

    return 0;
  }

  private getAgeInHours(ts: number): number {
    if (!ts) return Number.POSITIVE_INFINITY;
    return Math.max((Date.now() - ts) / (1000 * 60 * 60), 0);
  }

  private extractTags(text: string): string[] {
    const blacklist = new Set(['empleo', 'trabajo', 'jobs', 'job', 'remote', 'remoto', 'titulo', 'descripcion']);
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

  private extractLocation(snippet: string, countryText: string): string {
    const normalized = this.normalize(snippet);
    const mappings: Array<{ city: string; country: string }> = [
      { city: 'lima', country: 'Peru' },
      { city: 'arequipa', country: 'Peru' },
      { city: 'trujillo', country: 'Peru' },
      { city: 'cdmx', country: 'Mexico' },
      { city: 'guadalajara', country: 'Mexico' },
      { city: 'monterrey', country: 'Mexico' },
      { city: 'buenos aires', country: 'Argentina' },
      { city: 'santiago', country: 'Chile' },
      { city: 'bogota', country: 'Colombia' },
      { city: 'madrid', country: 'Spain' },
      { city: 'barcelona', country: 'Spain' },
      { city: 'new york', country: 'United States' },
      { city: 'california', country: 'United States' },
      { city: 'texas', country: 'United States' },
    ];

    for (const item of mappings) {
      if (normalized.includes(item.city)) {
        return `${item.city[0].toUpperCase()}${item.city.slice(1)}, ${item.country}`;
      }
    }

    const tokens = this.getCountryTokens(countryText);
    if (tokens.some((token) => normalized.includes(token))) return countryText;
    return `${countryText} (no especificado)`;
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

  private buildPortalSearchFallback(keywords: string[], countryText: string, cityOrRegion: string): MatchedJob[] {
    const location = cityOrRegion ? `${cityOrRegion}, ${countryText}` : countryText;
    const seeds = keywords.length ? keywords.slice(0, 20) : ['practicante', 'analista', 'asistente', 'python'];
    const sources = ['Computrabajo', 'Indeed', 'Bumeran', 'LinkedIn', 'Glassdoor'] as const;

    const entries: MatchedJob[] = [];
    for (const seed of seeds) {
      for (const source of sources) {
        const url = this.buildSourceSearchUrl(source, seed, countryText, cityOrRegion);
        entries.push({
          title: `Buscar "${seed}" en ${source} (${location})`,
          company: source,
          location,
          source,
          url,
          tags: [seed, ...seeds.slice(0, 4)],
          score: 18,
          publishedAt: 'Sin fecha',
          publishedTs: 0,
        });
      }
    }

    return entries;
  }

  private buildSourceSearchUrl(source: string, keyword: string, countryText: string, cityOrRegion: string): string {
    const q = encodeURIComponent(keyword);
    const location = cityOrRegion ? `${cityOrRegion}, ${countryText}` : countryText;
    const l = encodeURIComponent(location);

    if (source === 'LinkedIn') {
      return `https://www.linkedin.com/jobs/search/?keywords=${q}&location=${l}`;
    }
    if (source === 'Indeed') {
      return `https://www.indeed.com/jobs?q=${q}&l=${l}`;
    }
    if (source === 'Computrabajo') {
      return `https://www.bing.com/search?q=${encodeURIComponent(`site:computrabajo.com ${keyword} ${location}`)}`;
    }
    if (source === 'Bumeran') {
      return `https://www.bing.com/search?q=${encodeURIComponent(`site:bumeran.com ${keyword} ${location}`)}`;
    }
    return `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${q}&locT=C&locId=1`;
  }

  private mergeAndDedupe(items: MatchedJob[]): MatchedJob[] {
    const map = new Map<string, MatchedJob>();
    for (const item of items) {
      if (!item.url) continue;
      const key = this.normalize(`${item.source}|${item.url.split('?')[0]}`);
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

  private parsePublished(raw: string): { ts: number; label: string } {
    if (!raw) return { ts: 0, label: 'Sin fecha' };
    const dt = Date.parse(raw);
    if (Number.isNaN(dt)) return { ts: 0, label: this.clean(raw).slice(0, 20) || 'Sin fecha' };
    return { ts: dt, label: this.toRelativeLabel(dt) };
  }

  private toRelativeLabel(ts: number): string {
    const diffMs = Math.max(Date.now() - ts, 0);
    const hour = 3600 * 1000;
    const day = 24 * hour;
    const week = 7 * day;

    if (diffMs < day) return `${Math.max(Math.floor(diffMs / hour), 1)} h`;
    if (diffMs < week) return `${Math.max(Math.floor(diffMs / day), 1)} d`;
    return `${Math.max(Math.floor(diffMs / week), 1)} sem`;
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
