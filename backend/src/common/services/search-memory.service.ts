import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MatchedJob } from './job-search.service';

export interface LearningProfile {
  keywordWeights: Record<string, number>;
  sourceWeights: Record<string, number>;
}

interface MemoryBucket {
  keywordWeights: Record<string, number>;
  sourceWeights: Record<string, number>;
  updates: number;
  updatedAt: string;
}

interface MemoryDb {
  buckets: Record<string, MemoryBucket>;
}

@Injectable()
export class SearchMemoryService {
  private readonly filePath = path.join(process.cwd(), 'data', 'search-memory.json');

  async getProfile(country: string, level: string): Promise<LearningProfile> {
    const db = await this.readDb();
    const key = this.buildBucketKey(country, level);
    const bucket = db.buckets[key];
    if (!bucket) {
      return {
        keywordWeights: {},
        sourceWeights: {},
      };
    }

    return {
      keywordWeights: bucket.keywordWeights || {},
      sourceWeights: bucket.sourceWeights || {},
    };
  }

  async learnFromResults(
    country: string,
    level: string,
    searchedKeywords: string[],
    jobs: MatchedJob[],
  ): Promise<void> {
    if (!jobs.length || !searchedKeywords.length) return;

    const db = await this.readDb();
    const key = this.buildBucketKey(country, level);
    const bucket = db.buckets[key] || {
      keywordWeights: {},
      sourceWeights: {},
      updates: 0,
      updatedAt: new Date().toISOString(),
    };

    const topJobs = jobs.slice(0, 20);
    const normalizedKeywords = searchedKeywords.map((k) => this.normalize(k)).filter(Boolean);

    for (const keyword of normalizedKeywords) {
      let hits = 0;
      for (const job of topJobs) {
        const haystack = this.normalize(`${job.title} ${job.tags.join(' ')}`);
        if (haystack.includes(keyword)) hits += 1;
      }
      if (hits > 0) {
        const current = bucket.keywordWeights[keyword] || 0;
        bucket.keywordWeights[keyword] = Math.min(current + hits * 0.2, 6);
      }
    }

    topJobs.forEach((job, index) => {
      const src = this.normalize(job.source);
      if (!src) return;
      const bonus = Math.max(1.2 - index * 0.05, 0.2);
      const current = bucket.sourceWeights[src] || 0;
      bucket.sourceWeights[src] = Math.min(current + bonus, 8);
    });

    bucket.updates += 1;
    bucket.updatedAt = new Date().toISOString();
    db.buckets[key] = bucket;

    await this.writeDb(db);
  }

  private buildBucketKey(country: string, level: string): string {
    return `${this.normalize(country) || 'global'}|${this.normalize(level) || 'unknown'}`;
  }

  private normalize(value: string): string {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async readDb(): Promise<MemoryDb> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as MemoryDb;
      return {
        buckets: parsed?.buckets || {},
      };
    } catch {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const initial: MemoryDb = { buckets: {} };
      await fs.writeFile(this.filePath, JSON.stringify(initial, null, 2), 'utf8');
      return initial;
    }
  }

  private async writeDb(data: MemoryDb): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8');
  }
}
