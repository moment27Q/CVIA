# Hackeador de Computrabajo y Bumeran

Proyecto SaaS para generar CV y carta de presentacion optimizados para ATS usando una URL de oferta laboral + IA (Google Gemini).

## Stack

- Frontend: React + Vite
- Backend: Nest.js (TypeScript)
- Scraping: Axios + Cheerio
- IA: Google Gemini API
- PDF premium: PDFKit

## Funciones principales

- Generador ATS por oferta:
  - Pegas URL de vacante
  - Recibes CV adaptado + carta
- Empleos por CV:
  - Subes CV (PDF, TXT, MD, CSV) o pegas texto
  - Busqueda enfocada en Peru (Computrabajo, Indeed, Bumeran, LinkedIn y portal estatal)
  - Se extraen keywords y se buscan vacantes en internet (fuentes publicas)

## Modelo de negocio implementado

- Plan gratis: 3 postulaciones por usuario (`userId`)
- Plan premium: S/15/mes (simulado en esta version) con exportacion PDF premium

## Estructura

- `backend/`: API Nest
- `frontend/`: interfaz React

## Configuracion

1. Backend

- Copiar `backend/.env.example` a `backend/.env`
- Colocar tu API key:

```env
GEMINI_API_KEY=TU_API_KEY
GEMINI_MODEL=gemini-1.5-flash
PORT=4000
```

2. Frontend

- (Opcional) crear `frontend/.env` si quieres otro backend:

```env
VITE_API_BASE=http://localhost:4000
```

## Ejecutar

1. Backend

```bash
cd backend
npm install
npm run start:dev
```

2. Frontend

```bash
cd frontend
npm install
npm run dev
```

## Endpoints

- `POST /api/job/generate`

```json
{
  "jobUrl": "https://...",
  "userId": "correo@ejemplo.com",
  "fullName": "Nombre Apellido",
  "profileSummary": "...",
  "oldCvText": "...",
  "education": "...",
  "skills": "Excel, SQL",
  "plan": "free"
}
```

- `POST /api/job/export-pdf`
  - requiere `plan: "premium"`

```json
{
  "userId": "correo@ejemplo.com",
  "fullName": "Nombre Apellido",
  "plan": "premium",
  "cvText": "...",
  "coverLetter": "..."
}
```

- `POST /api/job/match-cv-jobs` (multipart/form-data)
  - campos opcionales: `cvFile`, `cvText`, `desiredRole`, `location`
  - se recomienda enviar `cvFile` en PDF/TXT/MD/CSV o `cvText` pegado manualmente

## Notas

- Algunos portales bloquean scraping automatizado. Si falla, prueba con una oferta publica accesible sin login.
- Si Gemini falla o no hay API key, el backend usa fallback local para no romper el flujo.
- "Todos los empleos de internet" no es tecnicamente posible; este MVP consulta e indexa fuentes publicas con foco Peru.
