const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

export async function generateApplication(payload) {
  const res = await fetch(`${API_BASE}/api/job/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Error al generar postulacion');
  }
  return data;
}

export async function exportPremiumPdf(payload) {
  const res = await fetch(`${API_BASE}/api/job/export-pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Error al exportar PDF');
  }
  return data;
}

export async function matchJobsByCv({ cvFile, cvText, desiredRole, location, country }) {
  const formData = new FormData();
  if (cvFile) formData.append('cvFile', cvFile);
  if (cvText) formData.append('cvText', cvText);
  if (desiredRole) formData.append('desiredRole', desiredRole);
  if (location) formData.append('location', location);
  if (country) formData.append('country', country);

  const res = await fetch(`${API_BASE}/api/job/match-cv-jobs`, {
    method: 'POST',
    body: formData,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Error al buscar empleos por CV');
  }
  return data;
}

export async function generateCareerPathFromCv(payload) {
  const formData = new FormData();
  if (payload.cvFile) formData.append('cvFile', payload.cvFile);
  if (payload.cvText) formData.append('cvText', payload.cvText);
  if (payload.targetRole) formData.append('targetRole', payload.targetRole);
  if (payload.userId) formData.append('userId', payload.userId);

  const res = await fetch(`${API_BASE}/api/recruiting/career-path-from-cv`, {
    method: 'POST',
    body: formData,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Error al generar ruta de carrera');
  }
  return data;
}
