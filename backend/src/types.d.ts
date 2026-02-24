declare module 'pdfkit';
declare module 'pdf-parse';

declare namespace Express {
  namespace Multer {
    interface File {
      buffer: Buffer;
      originalname?: string;
      mimetype?: string;
      size?: number;
    }
  }
}
