import { Injectable } from '@nestjs/common';
import pdfParse from 'pdf-parse';

@Injectable()
export class CvParserService {
  async parseCv(inputText: string, file?: { originalname?: string; mimetype?: string; buffer?: Buffer }): Promise<string> {
    const typed = (inputText || '').trim();
    const fromFile = file?.buffer ? await this.parseFromBuffer(file) : '';
    const merged = [typed, fromFile].filter(Boolean).join('\n').replace(/\r/g, '\n').trim();
    return merged.slice(0, 120000);
  }

  private async parseFromBuffer(file?: { originalname?: string; mimetype?: string; buffer?: Buffer }): Promise<string> {
    if (!file?.buffer) return '';
    const name = String(file.originalname || '').toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();

    const isPdf = mime.includes('pdf') || name.endsWith('.pdf');
    const isTextLike =
      mime.includes('text') ||
      mime.includes('json') ||
      mime.includes('xml') ||
      name.endsWith('.txt') ||
      name.endsWith('.md') ||
      name.endsWith('.csv');

    if (isPdf) {
      try {
        const parsed = await pdfParse(file.buffer);
        return String(parsed.text || '').replace(/\u0000/g, ' ').trim();
      } catch {
        return '';
      }
    }

    if (!isTextLike) {
      return '';
    }

    return file.buffer.toString('utf8').replace(/\u0000/g, ' ').trim();
  }
}
