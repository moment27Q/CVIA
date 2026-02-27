import { Injectable } from '@nestjs/common';
import axios from 'axios';

export interface AdzunaJob {
  title: string;
  company: string;
  location: string;
  description: string;
  url: string;
  salary_min: number | null;
  salary_max: number | null;
  created: string;
  source: string;
}

@Injectable()
export class AdzunaService {
  private readonly appId = (process.env.ADZUNA_APP_ID || '').trim();
  private readonly appKey = (process.env.ADZUNA_APP_KEY || '').trim();
  private readonly baseUrl = (process.env.ADZUNA_BASE_URL || 'https://api.adzuna.com/v1/api/jobs').trim();

  isConfigured(): boolean {
    return Boolean(this.appId && this.appKey && this.baseUrl);
  }

  async searchJobs(keywords: string[], country: string, page: number): Promise<AdzunaJob[]> {
    if (!this.isConfigured()) return [];

    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const countryCode = this.resolveAdzunaCountry(country);
    const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/${countryCode}/search/${safePage}`;
    const query = (keywords || []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 10).join(' ');

    try {
      const response = await axios.get(endpoint, {
        timeout: 20000,
        params: {
          app_id: this.appId,
          app_key: this.appKey,
          what: query || 'software developer',
          results_per_page: 50,
          content_type: 'application/json',
        },
      });

      const payload = response.data as Record<string, unknown>;
      const rows = Array.isArray(payload?.results) ? payload.results : [];

      return rows
        .map((row) => this.mapJob(row))
        .filter((row): row is AdzunaJob => Boolean(row));
    } catch {
      return [];
    }
  }

  private mapJob(input: unknown): AdzunaJob | null {
    if (!input || typeof input !== 'object') return null;
    const row = input as Record<string, unknown>;

    const companyObj = row.company && typeof row.company === 'object' ? (row.company as Record<string, unknown>) : {};
    const locationObj = row.location && typeof row.location === 'object' ? (row.location as Record<string, unknown>) : {};

    const title = this.clean(this.pickString(row, ['title']));
    const company = this.clean(this.pickString(companyObj, ['display_name', 'name'])) || 'Empresa no detectada';
    const location = this.clean(this.pickString(locationObj, ['display_name', 'area'])) || 'No especificado';
    const description = this.clean(this.pickString(row, ['description']));
    const url = this.clean(this.pickString(row, ['redirect_url', 'url', 'adref']));
    const created = this.clean(this.pickString(row, ['created'])) || new Date().toISOString();

    if (!title || !url) return null;

    return {
      title,
      company,
      location,
      description,
      url,
      salary_min: this.pickNumber(row, ['salary_min']),
      salary_max: this.pickNumber(row, ['salary_max']),
      created,
      source: 'Adzuna',
    };
  }

  private resolveAdzunaCountry(country: string): string {
    const normalized = this.normalize(country);
    if (!normalized) return 'us';

    const map: Record<string, string> = {
      'united states': 'us',
      usa: 'us',
      us: 'us',
      peru: 'us',
      mexico: 'mx',
      mx: 'mx',
      argentina: 'us',
      ar: 'us',
      chile: 'us',
      cl: 'us',
      colombia: 'us',
      co: 'us',
      spain: 'gb',
      espana: 'gb',
      es: 'gb',
      uk: 'gb',
      'united kingdom': 'gb',
      gb: 'gb',
      germany: 'de',
      de: 'de',
      france: 'fr',
      fr: 'fr',
      italy: 'it',
      it: 'it',
      netherlands: 'nl',
      nl: 'nl',
      poland: 'pl',
      pl: 'pl',
      canada: 'ca',
      ca: 'ca',
      brazil: 'br',
      br: 'br',
      india: 'in',
      in: 'in',
      singapore: 'sg',
      sg: 'sg',
      australia: 'au',
      au: 'au',
      'new zealand': 'nz',
      nz: 'nz',
      'south africa': 'za',
      za: 'za',
    };

    return map[normalized] || 'us';
  }

  private pickString(record: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
      if (Array.isArray(value) && value.length) {
        const joined = value.map((x) => String(x || '').trim()).filter(Boolean).join(', ');
        if (joined) return joined;
      }
    }
    return '';
  }

  private pickNumber(record: Record<string, unknown>, keys: string[]): number | null {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return null;
  }

  private normalize(value: string): string {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private clean(value: string): string {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }
}
