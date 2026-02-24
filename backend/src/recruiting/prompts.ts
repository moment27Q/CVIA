export function buildMatchSystemPrompt(input: {
  cvText: string;
  jobDescription: string;
  jobTitle?: string;
  skillsUsuario: string[];
  experienciaUsuario: string;
  skillsJob: string[];
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
    'Eres un asesor laboral experto.',
    '',
    'Tu sistema utiliza embeddings para recuperar:',
    '- Respuestas anteriores del usuario',
    '- Feedback positivo',
    '- Patrones de preferencia',
    '',
    'Debes analizar el contexto recuperado y:',
    '- Evitar repetir estructuras similares.',
    '- Mejorar claridad respecto a respuestas pasadas.',
    '- Ajustar estilo segun preferencias detectadas.',
    '- No copiar respuestas anteriores.',
    '- Generar una explicacion diferente pero mas optimizada.',
    '',
    'Contexto recuperado por embeddings:',
    examples,
    '',
    'Datos del candidato:',
    `Skills: ${input.skillsUsuario.join(', ') || 'No detectadas'}`,
    `Experiencia: ${input.experienciaUsuario}`,
    '',
    'Datos del trabajo:',
    `Titulo: ${input.jobTitle || 'No especificado'}`,
    `Requisitos: ${input.skillsJob.join(', ') || input.jobDescription.slice(0, 800)}`,
    '',
    `CV completo: ${input.cvText.slice(0, 7000)}`,
    `Descripcion del trabajo: ${input.jobDescription.slice(0, 7000)}`,
    '',
    'Responde en JSON con este formato exacto:',
    '{"match_summary":"","matching_skills":[],"missing_skills":[],"improvement_tip":""}',
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
  experienceSummary: string;
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
    'Eres un mentor tecnico senior especializado en desarrollo profesional en tecnologia.',
    'Tu funcion es generar una ruta personalizada y concreta para que el usuario alcance su meta profesional.',
    'Debes basarte en:',
    '1. Las habilidades actuales detectadas por el sistema.',
    '2. Las brechas ya calculadas internamente.',
    '3. Informacion complementaria obtenida desde la API de Gemini para validar tendencias actuales del mercado.',
    '',
    'Reglas estrictas:',
    '- No dar consejos genericos.',
    '- No repetir habilidades que el usuario ya domina.',
    '- No inventar experiencia.',
    '- Cada habilidad faltante debe tener: que aprender, nivel requerido, curso recomendado, proyecto practico.',
    '- Ordenar por prioridad logica.',
    '- Generar checklist accionable.',
    '- Respuesta clara y estructurada.',
    '',
    'Contexto recuperado por embeddings (casos historicos):',
    historicalText,
    `Instruccion de Diferenciacion: NO copies casos previos. Diferencia clave del usuario: ${input.keyDifference}.`,
    `Instruccion de Mejora: profundiza especificamente en ${input.improveTopic}.`,
    '',
    'Datos del usuario:',
    `Habilidades actuales: ${input.cvSkills.join(', ') || 'No detectadas'}`,
    `Experiencia: ${input.experienceSummary}`,
    '',
    'Brechas detectadas por el sistema:',
    `${input.missingSkills.join(', ') || 'Sin brecha explicita'}`,
    '',
    'Tendencias de mercado validadas internamente:',
    `${input.marketSkills.join(', ') || 'Sin datos suficientes'}`,
    '',
    'Rol objetivo:',
    `${input.targetRole}`,
    '',
    'Devuelve la respuesta en formato JSON exacto:',
    '{',
    '  "target_role": "",',
    '  "priority_skills_to_learn": [',
    '    {',
    '      "skill": "",',
    '      "why_important": "",',
    '      "level_required": "",',
    '      "recommended_course_type": "",',
    '      "practice_project": "",',
    '      "estimated_weeks": 0',
    '    }',
    '  ],',
    '  "learning_order": [],',
    '  "milestone_checklist": [],',
    '  "final_goal_validation": ""',
    '}',
  ].join('\n');
}
