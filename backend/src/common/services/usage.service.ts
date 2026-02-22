import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { UsageRecord } from '../types';

@Injectable()
export class UsageService {
  private readonly filePath = path.join(process.cwd(), 'data', 'usage.json');

  async getOrCreate(userId: string): Promise<UsageRecord> {
    const db = await this.readDb();
    if (!db[userId]) {
      db[userId] = {
        userId,
        freeUses: 0,
        updatedAt: new Date().toISOString(),
      };
      await this.writeDb(db);
    }
    return db[userId];
  }

  async incrementFreeUse(userId: string): Promise<void> {
    const db = await this.readDb();
    const current = db[userId] || {
      userId,
      freeUses: 0,
      updatedAt: new Date().toISOString(),
    };

    current.freeUses += 1;
    current.updatedAt = new Date().toISOString();
    db[userId] = current;

    await this.writeDb(db);
  }

  private async readDb(): Promise<Record<string, UsageRecord>> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as Record<string, UsageRecord>;
    } catch {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, '{}', 'utf8');
      return {};
    }
  }

  private async writeDb(data: Record<string, UsageRecord>): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8');
  }
}
