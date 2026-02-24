export function buildMatchSystemPrompt(input: {
  cvText: string;
  jobDescription: string;
  jobTitle?: string;
  similarAcceptedCases: Array<{
    candidateSummary: string;
    jobSummary: string;
    whyAccepted: string;
  }>;
}) {
  const examples = input.similarAcceptedCases.length
    ? input.similarAcceptedCases
        .slice(0, 4)
        .map(
          (c, idx) =>
            `Caso ${idx + 1} (aceptado)\nCandidato: ${c.candidateSummary}\nPuesto: ${c.jobSummary}\nMotivo: ${c.whyAccepted}`,
        )
        .join('\n\n')
    : 'No hay casos previos.';

  return [
    'Eres un Recruiter AI senior.',
    'Responde SOLO JSON valido con esta forma:',
    '{"compatibilityScore":0,"decision":"strong_match|possible_match|weak_match","reasons":[],"missingSkills":[],"interviewFocus":[]}',
    'Usa el contexto de casos aceptados para calibrar el score.',
    `JOB TITLE: ${input.jobTitle || 'No especificado'}`,
    `JOB DESCRIPTION: ${input.jobDescription}`,
    `CV: ${input.cvText}`,
    `CASOS RAG (aceptados):\n${examples}`,
  ].join('\n');
}

export function buildCareerPathSystemPrompt(input: {
  currentProfile: string;
  targetRole: string;
  priorSuccessfulPaths: Array<{ targetRole: string; summary: string; successfulSteps: string[] }>;
}) {
  const successful = input.priorSuccessfulPaths.length
    ? input.priorSuccessfulPaths
        .slice(0, 4)
        .map(
          (p, idx) =>
            `Ruta ${idx + 1} objetivo=${p.targetRole}\nResumen: ${p.summary}\nPasos utiles: ${p.successfulSteps.join(', ')}`,
        )
        .join('\n\n')
    : 'No hay rutas historicas.';

  return [
    'Eres un Mentor de Carrera técnico.',
    'Responde SOLO JSON valido con esta forma:',
    '{"summary":"","estimatedMonths":0,"steps":[{"title":"","goal":"","skills":[],"resources":[],"etaWeeks":0}]}',
    'Prioriza pasos que hayan sido utiles para perfiles parecidos.',
    `PERFIL ACTUAL: ${input.currentProfile}`,
    `ROL OBJETIVO: ${input.targetRole}`,
    `RUTAS RAG (historicas):\n${successful}`,
  ].join('\n');
}
