import { useMemo, useState } from 'react';

const STATUS_ORDER = ['pending', 'in_progress', 'completed'];

function statusLabel(status) {
  if (status === 'in_progress') return 'En progreso';
  if (status === 'completed') return 'Completado';
  return 'Pendiente';
}

function statusClasses(status) {
  if (status === 'completed') return 'bg-emerald-100 text-emerald-800 border-emerald-300';
  if (status === 'in_progress') return 'bg-amber-100 text-amber-800 border-amber-300';
  return 'bg-slate-100 text-slate-700 border-slate-300';
}

function nextStatus(status) {
  const idx = STATUS_ORDER.indexOf(status);
  return STATUS_ORDER[(idx + 1) % STATUS_ORDER.length];
}

export default function CareerPathRoadmap({
  currentRole = 'Perfil actual',
  targetRole = 'Rol objetivo',
  matchPercent = 0,
  steps = [],
  marketSkills = [],
  missingSkills = [],
  onStatusChange,
  onRequestResources,
  userLevel = 'junior',
}) {
  const [statusMap, setStatusMap] = useState(() =>
    steps.reduce((acc, _, i) => {
      acc[i] = 'pending';
      return acc;
    }, {}),
  );
  const [resourceState, setResourceState] = useState({
    open: false,
    loading: false,
    error: '',
    stepTitle: '',
    skill: '',
    payload: null,
    cached: false,
  });

  const normalizedMarketSkills = useMemo(
    () => new Set((marketSkills || []).map((s) => String(s).toLowerCase().trim())),
    [marketSkills],
  );

  const recommendedCount = useMemo(
    () =>
      steps.filter((step) =>
        (step.skills || []).some((skill) => normalizedMarketSkills.has(String(skill).toLowerCase().trim())),
      ).length,
    [steps, normalizedMarketSkills],
  );

  const handleToggle = (idx) => {
    setStatusMap((prev) => {
      const updated = { ...prev, [idx]: nextStatus(prev[idx] || 'pending') };
      if (onStatusChange) onStatusChange(idx, updated[idx]);
      return updated;
    });
  };

  const handleOpenResources = async (step) => {
    const skill = (step.skills && step.skills[0]) || step.title || 'Skill';
    setResourceState({
      open: true,
      loading: true,
      error: '',
      stepTitle: step.title || 'Paso',
      skill,
      payload: null,
      cached: false,
    });

    if (!onRequestResources) {
      setResourceState((prev) => ({
        ...prev,
        loading: false,
        error: 'No hay conexion con recursos IA.',
      }));
      return;
    }

    try {
      const result = await onRequestResources({
        skill_name: skill,
        user_level: userLevel,
      });
      setResourceState((prev) => ({
        ...prev,
        loading: false,
        payload: result?.data || null,
        cached: Boolean(result?.cached),
      }));
    } catch (error) {
      setResourceState((prev) => ({
        ...prev,
        loading: false,
        error: error?.message || 'No se pudo cargar recursos',
      }));
    }
  };

  return (
    <section className="w-full rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
      <header className="mb-6 grid gap-3 md:grid-cols-3 md:items-center">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Rol actual</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{currentRole}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Rol objetivo</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{targetRole}</p>
        </div>
        <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-3 text-center">
          <p className="text-xs font-semibold uppercase tracking-wide text-cyan-700">Compatibilidad</p>
          <p className="mt-1 text-lg font-bold text-cyan-900">{matchPercent}% Match con el perfil ideal</p>
          <p className="text-xs text-cyan-700">{recommendedCount} pasos recomendados por datos</p>
        </div>
      </header>

      <div className="mb-4 flex flex-wrap gap-2">
        {(missingSkills || []).slice(0, 12).map((skill) => (
          <span key={skill} className="rounded-full border border-fuchsia-200 bg-fuchsia-50 px-3 py-1 text-xs font-semibold text-fuchsia-700">
            Brecha: {skill}
          </span>
        ))}
      </div>

      <ol className="relative space-y-6 border-l-2 border-slate-200 pl-5">
        {steps.map((step, idx) => {
          const status = statusMap[idx] || 'pending';
          const isDataRecommended = (step.skills || []).some((skill) =>
            normalizedMarketSkills.has(String(skill).toLowerCase().trim()),
          );

          return (
            <li key={`${step.title}-${idx}`} className="relative">
              <span className="absolute -left-[29px] top-6 h-4 w-4 rounded-full border-2 border-white bg-cyan-500 shadow" />
              <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold text-slate-900">{step.title || `Paso ${idx + 1}`}</h3>
                  {isDataRecommended && (
                    <span className="rounded-full border border-cyan-200 bg-cyan-50 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-cyan-700">
                      IA Insight: Recomendado por Datos
                    </span>
                  )}
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${statusClasses(status)}`}>
                    {statusLabel(status)}
                  </span>
                </div>

                <p className="mb-3 text-sm leading-relaxed text-slate-700">{step.goal || step.description || 'Sin descripcion.'}</p>

                {(step.skills || []).length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-2">
                    {step.skills.slice(0, 10).map((skill) => (
                      <span key={skill} className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
                        {skill}
                      </span>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs font-medium text-slate-500">ETA: {step.etaWeeks || 4} semanas</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => handleOpenResources(step)}
                      className="rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-2 text-xs font-semibold text-cyan-800 transition hover:bg-cyan-100"
                    >
                      Ver recursos IA
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggle(idx)}
                      className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-700"
                    >
                      Marcar estado
                    </button>
                  </div>
                </div>
              </article>
            </li>
          );
        })}
      </ol>

      {resourceState.open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/45 p-3 md:items-center">
          <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-4 shadow-xl md:p-5">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h4 className="text-base font-bold text-slate-900">Detalle de Recursos de Aprendizaje</h4>
                <p className="text-sm text-slate-600">
                  {resourceState.stepTitle} · <span className="font-semibold">{resourceState.skill}</span>
                </p>
                {resourceState.cached && (
                  <p className="mt-1 text-xs font-semibold text-emerald-700">Cache diario aplicado (sin gasto de saldo IA)</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setResourceState((prev) => ({ ...prev, open: false }))}
                className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                Cerrar
              </button>
            </div>

            {resourceState.loading && <p className="text-sm text-slate-600">Consultando recomendaciones con Gemini...</p>}
            {resourceState.error && <p className="text-sm text-rose-700">{resourceState.error}</p>}

            {resourceState.payload && (
              <div className="space-y-3">
                <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Mejor curso gratuito</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">{resourceState.payload?.free_resource?.title}</p>
                  <p className="text-xs text-slate-600">
                    {resourceState.payload?.free_resource?.platform} · Buscar: {resourceState.payload?.free_resource?.url_search_term}
                  </p>
                </article>

                <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Mejor curso de pago</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">{resourceState.payload?.paid_resource?.title}</p>
                  <p className="text-xs text-slate-600">{resourceState.payload?.paid_resource?.platform}</p>
                </article>

                <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Proyecto práctico</p>
                  <p className="mt-1 text-sm text-slate-800">{resourceState.payload?.practice_project}</p>
                </article>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
