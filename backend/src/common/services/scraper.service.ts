import { Injectable } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { JobData } from '../types';

@Injectable()
export class ScraperService {
  async scrapeJob(url: string): Promise<JobData> {
    const { data: html } = await axios.get<string>(url, {
      timeout: 12000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
      },
    });

    const $ = cheerio.load(html);
    $('script, style, noscript, iframe').remove();

    const title = this.clean($('title').first().text()) || this.clean($('h1').first().text()) || 'Oferta laboral';
    const company =
      this.clean($('[class*=company], [id*=company], [data-company]').first().text()) || 'Empresa no detectada';

    const bodyText = this.clean($('body').text());
    const keywords = this.extractKeywords(bodyText);

    return {
      url,
      title,
      company,
      rawText: bodyText.slice(0, 12000),
      keywords,
    };
  }

  private extractKeywords(text: string): string[] {
    const blacklist = new Set([
      'para',
      'con',
      'por',
      'una',
      'del',
      'las',
      'los',
      'que',
      'esta',
      'este',
      'como',
      'trabajo',
      'empleo',
      'empresa',
      'años',
      'experiencia',
      'nivel',
      'peru',
      'perú',
    ]);

    const freq = new Map<string, number>();
    const words = text.toLowerCase().match(/[a-záéíóúñ0-9+#.]{4,}/g) || [];

    for (const word of words) {
      if (blacklist.has(word)) continue;
      freq.set(word, (freq.get(word) || 0) + 1);
    }

    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([word]) => word);
  }

  private clean(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }
}
