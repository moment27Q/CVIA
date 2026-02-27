# Plataforma ATS + Job Matching + Career Path IA

Aplicacion fullstack para:

- generar CV y carta de presentacion optimizados para una oferta laboral,
- buscar empleos segun tu CV,
- construir una ruta de carrera con IA + RAG.

## Caracteristicas

1. Generador ATS por URL de vacante
- Entrada: URL de oferta + datos base del candidato.
- Salida: analisis ATS, CV adaptado y cover letter.
- Control de uso por plan:
  - `free`: limite de 3 usos por `userId`.
  - `premium`: habilita exportacion PDF premium.

2. Matching de empleos por CV
- Soporta CV por archivo (`PDF/TXT/MD/CSV`) o texto pegado.
- Extrae skills/keywords/roles del CV.
- Consulta proveedores de empleos publicos y rankea compatibilidad.
- Genera analisis de empleabilidad y roadmap de brechas tecnicas.

3. Ruta de carrera IA (Career Path)
- Analiza CV y rol objetivo.
- Compara contra templates/historial (RAG).
- Propone skills faltantes y pasos accionables.
- Permite feedback y aceptacion de rol sugerido para aprendizaje futuro.

## Stack tecnico

- Frontend: React 18 + Vite 6 + Tailwind 4
- Backend: NestJS 10 + TypeScript
- IA: Google Gemini
- Scraping y data fetching: Axios + Cheerio
- Parsing CV PDF: `pdf-parse`
- PDF premium: `pdfkit`
- Persistencia:
  - modo archivo JSON (fallback local),
  - o PostgreSQL (recomendado para Career Path RAG).

## Arquitectura del repositorio

```text
.
|-- backend/
|   |-- src/
|   |   |-- job/               # ATS generation, PDF export, CV->jobs
|   |   |-- recruiting/        # CV match, career path, feedback, learning
|   |   `-- common/services/   # Gemini, scraper, parser, RAG, usage, etc.
|   |-- scripts/               # import/seed de datasets
|   |-- docs/                  # schema SQL (con y sin pgvector)
|   `-- data/                  # datasets y memoria local JSON
`-- frontend/
    `-- src/                   # UI de ATS, jobs y career roadmap
```

## Requisitos

- Node.js 18+ (recomendado 20+)
- npm 9+
- API key de Google Gemini
- PostgreSQL (opcional pero recomendado para flujos RAG de carrera)

## Variables de entorno

Crear `backend/.env`:

```env
# Obligatorio para IA
GEMINI_API_KEY=tu_api_key
GEMINI_MODEL=gemini-1.5-flash

# Opcional: logs de parse/debug
GEMINI_DEBUG=false

# Backend HTTP
PORT=4000

# Base de datos (opcion 1)
DATABASE_URL=postgres://user:password@localhost:5432/tu_db

# Base de datos (opcion 2 si no usas DATABASE_URL)
# PGHOST=localhost
# PGPORT=5432
# PGUSER=postgres
# PGPASSWORD=postgres
# PGDATABASE=tu_db

# Providers externos de jobs (opcionales)
# THEIRSTACK_API_KEY=
# THEIRSTACK_BASE_URL=https://api.theirstack.com/v1
# CORESIGNAL_API_KEY=
# CORESIGNAL_BASE_URL=https://api.coresignal.com/cdapi/v2
```

Crear `frontend/.env` (opcional):

```env
VITE_API_BASE=http://localhost:4000
```

## Instalacion y ejecucion

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

3. URLs locales

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:4000`

## Base de datos (recomendado para Career Path RAG)

Si vas a usar Career Path con persistencia/plantillas RAG en Postgres:

1. crea la BD y configura `DATABASE_URL` (o variables `PG*`),
2. ejecuta uno de estos esquemas:
   - `backend/docs/recruiting_schema.sql` (con `pgvector`)
   - `backend/docs/recruiting_schema_no_vector.sql` (sin `pgvector`)

Nota: varios endpoints funcionan en modo fallback local JSON, pero `career-path-from-cv` depende de configuracion de BD para flujo RAG completo.

## Scripts utiles (backend)

```bash
npm run start:dev
npm run build
npm run start

# Import/seed de datasets
npm run import:career-paths
npm run import:puestos-peru
npm run import:puestos-peru-2
npm run seed:cv-training
npm run seed:cv-training-roadmap
```

## API principal

Base URL local: `http://localhost:4000`

1. ATS / aplicaciones

- `POST /api/job/generate`
- `POST /api/job/export-pdf`
- `POST /api/job/match-cv-jobs` (multipart/form-data, archivo `cvFile`)

Ejemplo `POST /api/job/generate`:

```json
{
  "jobUrl": "https://example.com/job",
  "userId": "correo@ejemplo.com",
  "fullName": "Nombre Apellido",
  "profileSummary": "Resumen profesional",
  "oldCvText": "Texto CV previo",
  "education": "Formacion",
  "skills": "Excel, SQL, Power BI",
  "plan": "free"
}
```

2. Recruiting / learning / career

- `POST /api/recruiting/match`
- `POST /api/recruiting/match-learning`
- `POST /api/recruiting/career-path`
- `POST /api/recruiting/career-path-from-cv` (multipart/form-data, archivo `file`)
- `POST /api/recruiting/feedback`
- `POST /api/recruiting/get-learning-resources`
- `GET /api/recruiting/learning-stats`
- `POST /api/recruiting/accept-suggested-role`

Compat legacy adicional:

- `POST /api/get-learning-resources`

## Flujo funcional rapido

1. Entra a la pestana "Generador ATS" para adaptar CV/carta a una oferta.
2. Usa "Empleos por CV" para ranking de vacantes por compatibilidad.
3. Usa "Ruta de Carrera IA" para roadmap de skills hacia un rol objetivo.
4. Si aplica, acepta sugerencias y manda feedback para reforzar aprendizaje del sistema.

## Troubleshooting

- Error al generar IA:
  - Verifica `GEMINI_API_KEY`.
  - Si falla parseo de respuesta IA, habilita `GEMINI_DEBUG=true`.
- Career path devuelve fallback o vacio:
  - Revisa conexion a Postgres (`DATABASE_URL` o `PG*`).
  - Asegura schema aplicado desde `backend/docs/`.
- Pocos empleos encontrados:
  - Ajusta `country`, `location` y `desiredRole`.
  - Sube CV con texto claro y skills explicitas.
- Scraping de oferta falla:
  - prueba otra URL publica sin login ni bloqueo.

## Estado del proyecto

MVP funcional orientado a validacion de producto (ATS + matching + roadmap IA). Incluye mecanismos de fallback para mantener flujo incluso cuando algun proveedor externo falla.
