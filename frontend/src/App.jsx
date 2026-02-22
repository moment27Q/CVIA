import { useMemo, useState } from 'react';
import { exportPremiumPdf, generateApplication, matchJobsByCv } from './api';

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
  location: 'Peru',
  cvText: '',
};

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

  const canExportPdf = useMemo(() => form.plan === 'premium' && result, [form.plan, result]);

  const onChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const onCvChange = (e) => {
    const { name, value } = e.target;
    setCvForm((prev) => ({ ...prev, [name]: value }));
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
        location: cvForm.location,
      });
      setJobsResult(data);
    } catch (err) {
      setJobsError(err.message);
    } finally {
      setJobsLoading(false);
    }
  };

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

            <label>Ubicacion preferida (opcional)</label>
            <input name="location" value={cvForm.location} onChange={onCvChange} placeholder="Ej: Peru o Lima" />

            <button disabled={jobsLoading} type="submit">
              {jobsLoading ? 'Buscando empleos...' : 'Encontrar empleos para mi perfil'}
            </button>

            <p className="muted">
              Se consulta Peru en fuentes publicas como Computrabajo, Indeed, Bumeran, LinkedIn y portal estatal.
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
    </main>
  );
}
