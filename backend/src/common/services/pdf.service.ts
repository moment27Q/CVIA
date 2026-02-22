import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';

interface PremiumPdfInput {
  fullName: string;
  cvText: string;
  coverLetter: string;
}

@Injectable()
export class PdfService {
  async buildPremiumPdf(input: PremiumPdfInput): Promise<string> {
    return new Promise((resolve) => {
      const doc = new PDFDocument({ margin: 44, size: 'A4' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));

      doc.fontSize(20).text('CV Premium ATS', { align: 'left' });
      doc.moveDown(0.4);
      doc.fontSize(12).text(`Candidato: ${input.fullName}`);
      doc.moveDown();

      doc.fontSize(14).text('CV Adaptado', { underline: true });
      doc.moveDown(0.4);
      doc.fontSize(11).text(input.cvText, { align: 'left' });
      doc.addPage();

      doc.fontSize(14).text('Carta de Presentacion', { underline: true });
      doc.moveDown(0.4);
      doc.fontSize(11).text(input.coverLetter, { align: 'left' });

      doc.end();
    });
  }
}
