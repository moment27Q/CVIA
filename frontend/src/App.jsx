import { useMemo, useState } from 'react';
import {
  acceptSuggestedRole,
  exportPremiumPdf,
  generateApplication,
  generateCareerPathFromCv,
  getLearningResources,
  matchJobsByCv,
} from './api';
import CareerPathRoadmap from './components/CareerPathRoadmap';

const initial = {
  jobUrl: '',
  userId: '',
  fullName: '',
  profileSummary: '',
  oldCvText: '',
  education: '',
  skills: '',
  plan: 'free',
};

const cvInitial = {
  desiredRole: '',
  country: 'Peru',
  location: '',
  cvText: '',
};

const careerInitial = {
  userId: '',
  targetRole: '',
  cvText: '',
};

const countryOptions = ['Peru', 'United States', 'Mexico', 'Argentina', 'Chile', 'Colombia', 'Spain'];

export default function App() {
  const [view, setView] = useState('ats');

  const [form, setForm] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [pdfLoading, setPdfLoading] = useState(false);

  const [cvForm, setCvForm] = useState(cvInitial);
  const [cvFile, setCvFile] = useState(null);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState('');
  const [jobsResult, setJobsResult] = useState(null);

  const [careerForm, setCareerForm] = useState(careerInitial);
  const [careerLoading, setCareerLoading] = useState(false);
  const [careerError, setCareerError] = useState('');
  const [careerResult, setCareerResult] = useState(null);
  const [careerCvFile, setCareerCvFile] = useState(null);
  const [acceptingSuggestion, setAcceptingSuggestion] = useState(false);
  const [acceptSuggestionMessage, setAcceptSuggestionMessage] = useState('');

  const canExportPdf = useMemo(() => form.plan === 'premium' && result, [form.plan, result]);

  const onChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const onCvChange = (e) => {
    const { name, value } = e.target;
    setCvForm((prev) => ({ ...prev, [name]: value }));
  };

  const onCareerChange = (e) => {
    const { name, value } = e.target;
    setCareerForm((prev) => ({ ...prev, [name]: value }));
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);

    try {
      const data = await generateApplication(form);
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const onExportPdf = async () => {
    if (!result) return;
    setPdfLoading(true);
    setError('');

    try {
      const pdf = await exportPremiumPdf({
        userId: form.userId,
        fullName: form.fullName,
        plan: form.plan,
        cvText: result.cvText,
        coverLetter: result.coverLetter,
      });

      const href = `data:${pdf.mimeType};base64,${pdf.data}`;
      const link = document.createElement('a');
      link.href = href;
      link.download = pdf.fileName;
      link.click();
    } catch (err) {
      setError(err.message);
    } finally {
      setPdfLoading(false);
    }
  };

  const onFindJobs = async (e) => {
    e.preventDefault();
    setJobsLoading(true);
    setJobsError('');
    setJobsResult(null);

    try {
      const data = await matchJobsByCv({
        cvFile,
        cvText: cvForm.cvText,
        desiredRole: cvForm.desiredRole,
        country: cvForm.country,
        location: cvForm.location,
      });
      setJobsResult(data);
    } catch (err) {
      setJobsError(err.message);
    } finally {
      setJobsLoading(false);
    }
  };

  const onGenerateCareer = async (e) => {
    e.preventDefault();
    setCareerLoading(true);
    setCareerError('');
    setCareerResult(null);
    setAcceptSuggestionMessage('');

    try {
      const data = await generateCareerPathFromCv({
        cvFile: careerCvFile,
        userId: careerForm.userId || 'anonymous',
        targetRole: careerForm.targetRole,
        cvText: careerForm.cvText,
      });
      setCareerResult(data);
    } catch (err) {
      setCareerError(err.message);
    } finally {
      setCareerLoading(false);
    }
  };

  const onAcceptSuggestion = async () => {
    const analysisId = Number(careerResult?.analysisId || careerResult?.gemini?.analysisId || 0);
    if (!analysisId) {
      setAcceptSuggestionMessage('No se encontro analysisId para confirmar.');
      return;
    }

    setAcceptingSuggestion(true);
    setAcceptSuggestionMessage('');
    try {
      const data = await acceptSuggestedRole({ analysisId });
      if (data?.accepted) {
        setAcceptSuggestionMessage('Sugerencia aceptada y guardada para entrenamiento.');
      } else {
        setAcceptSuggestionMessage('No se pudo marcar como aceptada.');
      }
    } catch (err) {
      setAcceptSuggestionMessage(err?.message || 'No se pudo aceptar la sugerencia.');
    } finally {
      setAcceptingSuggestion(false);
    }
  };

  const matchPercent = useMemo(() => {
    if (!careerResult) return 0;
    const currentMatchScore = Number(careerResult?.currentMatch?.matchPercentage ?? careerResult?.gemini?.currentMatch?.matchPercentage);
    if (Number.isFinite(currentMatchScore) && currentMatchScore > 0) {
      return Math.max(0, Math.min(100, Math.round(currentMatchScore)));
    }
    const market = (careerResult.marketSkills || []).length;
    const missing = (careerResult.missingSkills || []).length;
    if (!market) return 50;
    const score = Math.round(((market - missing) / market) * 100);
    return Math.max(0, Math.min(100, score));
  }, [careerResult]);

  const roadmapSteps = useMemo(() => {
    if (!careerResult) return [];
    const backendRoadmapSteps = careerResult?.roadmapToTarget?.steps;
    if (Array.isArray(backendRoadmapSteps) && backendRoadmapSteps.length > 0) {
      return backendRoadmapSteps;
    }
    return Array.isArray(careerResult.steps) ? careerResult.steps : [];
  }, [careerResult]);

  return (
    <main className="page">
      <section className="hero">
        <h1>Plataforma ATS + Matching de Empleos</h1>
        <p>
          Genera CV y carta para una oferta especifica o sube tu CV para descubrir empleos en internet a los que puedes postular.
        </p>

        <div className="tabs">
          <button className={view === 'ats' ? 'tab active' : 'tab'} onClick={() => setView('ats')} type="button">
            Generador ATS
          </button>
          <button className={view === 'jobs' ? 'tab active' : 'tab'} onClick={() => setView('jobs')} type="button">
            Empleos por CV
          </button>
          <button className={view === 'career' ? 'tab active' : 'tab'} onClick={() => setView('career')} type="button">
            Ruta de Carrera IA
          </button>
        </div>
      </section>

      {view === 'ats' && (
        <section className="grid">
          <form className="card" onSubmit={onSubmit}>
            <h2>Datos de postulacion</h2>

            <label>Link de oferta laboral</label>
            <input name="jobUrl" value={form.jobUrl} onChange={onChange} placeholder="https://..." required />

            <label>ID usuario o correo</label>
            <input name="userId" value={form.userId} onChange={onChange} placeholder="correo@ejemplo.com" required />

            <label>Nombre completo</label>
            <input name="fullName" value={form.fullName} onChange={onChange} required />

            <label>Resumen profesional</label>
            <textarea name="profileSummary" value={form.profileSummary} onChange={onChange} rows={3} />

            <label>CV anterior (texto)</label>
            <textarea name="oldCvText" value={form.oldCvText} onChange={onChange} rows={4} />

            <label>Educacion</label>
            <textarea name="education" value={form.education} onChange={onChange} rows={2} />

            <label>Skills</label>
            <input name="skills" value={form.skills} onChange={onChange} placeholder="Excel, SQL, atencion al cliente" />

            <label>Plan</label>
            <select name="plan" value={form.plan} onChange={onChange}>
              <option value="free">Gratis (3 postulaciones)</option>
              <option value="premium">Premium S/15 al mes</option>
            </select>

            <button disabled={loading} type="submit">
              {loading ? 'Generando...' : 'Generar CV y Carta'}
            </button>

            {error && <p className="error">{error}</p>}
          </form>

          <article className="card output">
            <h2>Resultado</h2>
            {!result && <p className="muted">Aqui veras el CV adaptado, carta y palabras clave detectadas.</p>}

            {result && (
              <>
                <p>
                  <strong>Puesto:</strong> {result.jobPreview?.title}
                </p>
                <p>
                  <strong>Empresa:</strong> {result.jobPreview?.company}
                </p>
                <p>
                  <strong>Keywords:</strong> {(result.keywords || []).join(', ')}
                </p>
                <p>
                  <strong>Postulaciones gratis restantes:</strong> {result.remainingFreeUses}
                </p>

                <h3>Analisis ATS</h3>
                <pre>{result.analysis}</pre>

                <h3>CV adaptado</h3>
                <pre>{result.cvText}</pre>

                <h3>Carta de presentacion</h3>
                <pre>{result.coverLetter}</pre>

                <button disabled={!canExportPdf || pdfLoading} onClick={onExportPdf} type="button">
                  {pdfLoading ? 'Exportando PDF...' : 'Descargar PDF Premium'}
                </button>
                {!canExportPdf && <p className="muted">El PDF premium esta disponible en plan premium.</p>}
              </>
            )}
          </article>
        </section>
      )}

      {view === 'jobs' && (
        <section className="grid-jobs">
          <form className="card" onSubmit={onFindJobs}>
            <h2>Sube tu CV y busca empleos</h2>

            <label>Archivo CV (PDF, TXT, MD, CSV)</label>
            <input
              type="file"
              accept=".pdf,.txt,.md,.csv,application/pdf,text/plain,text/markdown,text/csv"
              onChange={(e) => setCvFile(e.target.files?.[0] || null)}
            />

            <label>O pega tu CV en texto</label>
            <textarea
              name="cvText"
              value={cvForm.cvText}
              onChange={onCvChange}
              rows={8}
              placeholder="Pega aqui el contenido de tu CV"
            />

            <label>Rol objetivo (opcional)</label>
            <input
              name="desiredRole"
              value={cvForm.desiredRole}
              onChange={onCvChange}
              placeholder="Ej: analista de datos"
            />

            <label>Pais</label>
            <select name="country" value={cvForm.country} onChange={onCvChange}>
              {countryOptions.map((country) => (
                <option key={country} value={country}>
                  {country}
                </option>
              ))}
            </select>

            <label>Ciudad o region (opcional)</label>
            <input name="location" value={cvForm.location} onChange={onCvChange} placeholder="Ej: Lima, CDMX, Madrid" />

            <button disabled={jobsLoading} type="submit">
              {jobsLoading ? 'Buscando empleos...' : 'Encontrar empleos para mi perfil'}
            </button>

            <p className="muted">
              Se consulta Active Jobs DB (RapidAPI) en tiempo real y fuentes publicas (LinkedIn, Indeed, Computrabajo, etc).
            </p>

            {jobsError && <p className="error">{jobsError}</p>}
          </form>

          <article className="card output">
            <h2>Empleos recomendados</h2>
            {!jobsResult && <p className="muted">Aqui veras las vacantes segun tu CV.</p>}

            {jobsResult && (
              <>
                <p>
                  <strong>Total encontrado:</strong> {jobsResult.totalJobsFound}
                </p>
                <p>
                  <strong>Keywords detectadas:</strong> {(jobsResult.extractedKeywords || []).join(', ')}
                </p>
                <p className="muted">{jobsResult.note}</p>
                {Array.isArray(jobsResult.providerStatus) && jobsResult.providerStatus.length > 0 && (
                  <p className="muted">
                    {jobsResult.providerStatus
                      .map((p) =>
                        `${p.provider}: ${p.success ? `OK (${p.jobs})` : p.enabled ? `ERROR (${p.error || 'sin detalle'})` : `desactivado (${p.error || 'sin detalle'})`}`,
                      )
                      .join(' | ')}
                  </p>
                )}

                <div className="jobs-list">
                  {(jobsResult.jobs || []).map((job, idx) => (
                    <article className="job-item" key={`${job.url}-${idx}`}>
                      <h3>{job.title}</h3>
                      <p>
                        <strong>{job.company}</strong> | {job.location}
                      </p>
                      <p>
                        <strong>Fuente:</strong> {job.source} | <strong>Score:</strong> {job.score}
                      </p>
                      <p>
                        <strong>Publicado:</strong> {job.publishedAt || 'Sin fecha'}
                      </p>
                      <p className="muted">{(job.tags || []).slice(0, 8).join(', ')}</p>
                      <a href={job.url} target="_blank" rel="noreferrer">
                        Ver vacante
                      </a>
                    </article>
                  ))}
                </div>
              </>
            )}
          </article>
        </section>
      )}

      {view === 'career' && (
        <section className="grid-jobs">
          <form className="card" onSubmit={onGenerateCareer}>
            <h2>Generador de Ruta de Carrera</h2>

            <label>ID de usuario (opcional)</label>
            <input name="userId" value={careerForm.userId} onChange={onCareerChange} placeholder="matias" />

            <label>Rol objetivo</label>
            <input
              name="targetRole"
              value={careerForm.targetRole}
              onChange={onCareerChange}
              placeholder="Ej: Backend Developer"
              required
            />

            <label>CV en texto</label>
            <textarea
              name="cvText"
              value={careerForm.cvText}
              onChange={onCareerChange}
              rows={10}
              placeholder="Pega aqui tu CV (PDF convertido a texto)"
            />

            <label>O sube tu CV (PDF/TXT/MD/CSV)</label>
            <input
              type="file"
              accept=".pdf,.txt,.md,.csv,application/pdf,text/plain,text/markdown,text/csv"
              onChange={(e) => setCareerCvFile(e.target.files?.[0] || null)}
            />

            <button disabled={careerLoading} type="submit">
              {careerLoading ? 'Generando ruta...' : 'Generar Roadmap Personalizado'}
            </button>

            <p className="muted">
              Este flujo usa RAG: compara tu CV con perfiles exitosos y genera un plan para cerrar brechas.
            </p>

            {careerError && <p className="error">{careerError}</p>}
          </form>

          <article className="card output">
            <h2>CareerPathRoadmap</h2>
            {!careerResult && <p className="muted">Aqui veras tu roadmap tipo timeline con pasos accionables.</p>}

            {careerResult && (
              <>
                <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
                  <p>
                    <strong>Rol sugerido:</strong>{' '}
                    {careerResult?.currentMatch?.title || careerResult?.gemini?.suggestedRole || 'No disponible'}
                  </p>
                  <p>
                    <strong>Rol de template usado:</strong> {careerResult?.matchedRole || 'No disponible'}
                  </p>
                  <p>
                    <strong>Skills extraidas:</strong>{' '}
                    {Array.isArray(careerResult?.cvSkills) && careerResult.cvSkills.length
                      ? careerResult.cvSkills.join(', ')
                      : Array.isArray(careerResult?.gemini?.skills) && careerResult.gemini.skills.length
                        ? careerResult.gemini.skills.join(', ')
                        : 'No detectadas'}
                  </p>
                  <p>
                    <strong>CVs similares encontrados:</strong>{' '}
                    {careerResult?.gemini?.similarCVsFound ?? careerResult?.similarCVsFound ?? 0}
                  </p>
                  <button disabled={acceptingSuggestion} onClick={onAcceptSuggestion} type="button">
                    {acceptingSuggestion ? 'Aceptando...' : 'Aceptar sugerencia'}
                  </button>
                  {acceptSuggestionMessage && <p className="muted">{acceptSuggestionMessage}</p>}
                </div>

                <CareerPathRoadmap
                  currentRole={
                    careerResult?.currentMatch?.title || careerResult?.gemini?.suggestedRole || 'Perfil actual del CV'
                  }
                  targetRole={careerForm.targetRole}
                  matchPercent={matchPercent}
                  marketSkills={careerResult.marketSkills || []}
                  missingSkills={careerResult.missingSkills || []}
                  steps={roadmapSteps}
                  userLevel="junior"
                  onRequestResources={getLearningResources}
                />
              </>
            )}
          </article>
        </section>
      )}
    </main>
  );
}
