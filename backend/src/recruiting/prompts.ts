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

export function buildCareerPathGapPrompt(input: {
  targetRole: string;
  cvSkills: string[];
  marketSkills: string[];
  missingSkills: string[];
  cvText: string;
}) {
  return [
    'Actua como un Mentor de Carrera experto.',
    'Responde SOLO JSON valido con esta forma:',
    '{"summary":"","estimatedMonths":0,"gapAnalysis":{"currentSkills":[],"marketSkills":[],"missingSkills":[]},"steps":[{"title":"","goal":"","skills":[],"resources":[],"etaWeeks":0}]}',
    `El usuario quiere ser: ${input.targetRole}.`,
    `Sus habilidades actuales son: ${input.cvSkills.join(', ') || 'No detectadas'}.`,
    `LA VERDAD DEL MERCADO (Contexto Recuperado): En nuestra base de datos, los candidatos exitosos para este rol dominan estas tecnologias: ${input.marketSkills.join(', ') || 'Sin datos historicos suficientes'}.`,
    `Brecha detectada (skills faltantes): ${input.missingSkills.join(', ') || 'Brecha no clara, prioriza fundamentos del rol'}.`,
    'Genera un plan de estudio paso a paso para cubrir la brecha entre lo que sabe y lo que requiere el mercado segun nuestros datos.',
    'Prioriza las tecnologias del contexto recuperado.',
    `CV del usuario (resumen fuente): ${input.cvText.slice(0, 4000)}`,
  ].join('\n');
}

export function buildEvolvingCareerPathPrompt(input: {
  targetRole: string;
  cvSkills: string[];
  historicalCases: Array<{ targetRole: string; summary: string; successfulSteps: string[]; quality: number }>;
  marketSkills: string[];
  missingSkills: string[];
  keyDifference: string;
  improveTopic: string;
}) {
  const historicalText = input.historicalCases.length
    ? input.historicalCases
        .map(
          (c, idx) =>
            `Caso ${idx + 1} (quality=${c.quality})\nObjetivo: ${c.targetRole}\nResumen: ${c.summary}\nPasos utiles: ${c.successfulSteps.join(', ')}`,
        )
        .join('\n\n')
    : 'Sin casos historicos exitosos disponibles.';

  return [
    'Actua como un Mentor de Carrera experto.',
    'Responde SOLO JSON valido con esta forma:',
    '{"summary":"","estimatedMonths":0,"gapAnalysis":{"currentSkills":[],"marketSkills":[],"missingSkills":[]},"steps":[{"title":"","goal":"","skills":[],"resources":[],"etaWeeks":0}]}',
    '',
    `El usuario quiere ser ${input.targetRole}.`,
    `Sus habilidades actuales son: ${input.cvSkills.join(', ') || 'No detectadas'}.`,
    `LA VERDAD DEL MERCADO (Contexto Recuperado): En nuestra base de datos, los candidatos exitosos para este rol dominan estas tecnologias: ${input.marketSkills.join(', ') || 'Sin datos'}.`,
    '',
    `Contexto Historico: Aqui tienes como ayudamos a usuarios similares en el pasado:\n${historicalText}`,
    `Instruccion de Diferenciacion: Analiza los casos anteriores, pero NO LOS COPIES. El usuario actual tiene una diferencia clave: ${input.keyDifference}. Tu mision es refinar la estrategia anterior para cubrir esa brecha especifica.`,
    `Instruccion de Mejora: Si detectaste que en los casos pasados falto profundidad en ${input.improveTopic}, profundiza mas en esta nueva respuesta.`,
    '',
    `Brecha detectada: ${input.missingSkills.join(', ') || 'sin brecha explicita, reforzar stack objetivo'}.`,
    'Devuelve una ruta paso a paso accionable, priorizando tecnologias del contexto recuperado.',
  ].join('\n');
}
