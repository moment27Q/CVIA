import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { JobData } from '../types';

interface GenerateInput {
  jobData: JobData;
  candidate: {
    fullName: string;
    profileSummary: string;
    oldCvText: string;
    education: string;
    skills: string;
  };
  isPremium: boolean;
}

export interface CvInsights {
  keywords: string[];
  roles: string[];
  yearsExperience: number;
  level: 'intern' | 'junior' | 'mid' | 'senior';
  prefersInternships: boolean;
  englishLevel: 'basic' | 'intermediate' | 'advanced' | 'unknown';
  preferredJobTypes: string[];
}

@Injectable()
export class GeminiService {
  private readonly key = process.env.GEMINI_API_KEY || '';
  private readonly model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

  async generateJobApplication(input: GenerateInput) {
    if (!this.key) {
      return this.fallback(input);
    }

    const prompt = this.buildPrompt(input);
    const raw = await this.callModel(prompt, 1800);
    if (!raw) return this.fallback(input);
    return this.parseResult(raw, input.jobData.keywords);
  }

  async extractCvKeywords(cvText: string, desiredRole?: string): Promise<string[]> {
    const cleanText = cvText.replace(/\s+/g, ' ').trim();
    if (!cleanText) return [];
    const localKeywords = this.fallbackKeywords(cleanText, desiredRole);

    if (!this.key) {
      return this.postProcessKeywords(localKeywords, desiredRole);
    }

    const excerpt = this.buildCvExcerpt(cleanText);

    const prompt = [
      'Analiza este CV y devuelve SOLO JSON valido con esta forma:',
      '{"keywords":["keyword1","keyword2"],"roles":["rol1","rol2"]}',
      'Maximo 18 keywords y maximo 8 roles, en espanol o ingles segun el CV.',
      desiredRole ? `Rol objetivo declarado: ${desiredRole}` : 'Rol objetivo declarado: no especificado',
      `CV: ${excerpt}`,
    ].join('\n');

    const raw = await this.callModel(prompt, 700);
    if (!raw) return this.postProcessKeywords(localKeywords, desiredRole);

    try {
      const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      const parsed = JSON.parse(jsonText);
      const keywords = Array.isArray(parsed.keywords) ? parsed.keywords : [];
      const roles = Array.isArray(parsed.roles) ? parsed.roles : [];
      const merged = [...keywords, ...roles, ...localKeywords].map((x) => String(x).trim()).filter(Boolean).slice(0, 24);
      if (!merged.length) {
        return this.postProcessKeywords(localKeywords, desiredRole);
      }

      return this.postProcessKeywords(merged, desiredRole);
    } catch {
      return this.postProcessKeywords(localKeywords, desiredRole);
    }
  }

  async extractCvInsights(cvText: string, desiredRole?: string): Promise<CvInsights> {
    const cleanText = cvText.replace(/\s+/g, ' ').trim();
    const localKeywords = this.fallbackKeywords(cleanText, desiredRole);
    const local = this.buildLocalInsights(cleanText, desiredRole, localKeywords);

    if (!cleanText || !this.key) {
      return local;
    }

    const excerpt = this.buildCvExcerpt(cleanText);
    const prompt = [
      'Analiza este CV y devuelve SOLO JSON valido con esta forma exacta:',
      '{"keywords":[],"roles":[],"yearsExperience":0,"level":"intern|junior|mid|senior","prefersInternships":false,"englishLevel":"basic|intermediate|advanced|unknown","preferredJobTypes":[]}',
      'Reglas:',
      '- yearsExperience debe ser numero entero estimado (0-30).',
      '- preferredJobTypes usa terminos como: practica, trainee, junior, tiempo completo, remoto, hibrido.',
      '- keywords maximo 18, roles maximo 8.',
      desiredRole ? `Rol objetivo declarado: ${desiredRole}` : 'Rol objetivo declarado: no especificado',
      `CV: ${excerpt}`,
    ].join('\n');

    const raw = await this.callModel(prompt, 900);
    if (!raw) return local;

    try {
      const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      const parsed = JSON.parse(jsonText);

      const mergedKeywords = this.postProcessKeywords(
        [
          ...(Array.isArray(parsed.keywords) ? parsed.keywords : []),
          ...local.keywords,
        ],
        desiredRole,
      );

      const roles = [...new Set([
        ...(Array.isArray(parsed.roles) ? parsed.roles : []).map((x: unknown) => String(x).trim()).filter(Boolean),
        ...local.roles,
      ])].slice(0, 8);

      const yearsExperience = Math.max(
        0,
        Math.min(30, Number.isFinite(Number(parsed.yearsExperience)) ? Math.floor(Number(parsed.yearsExperience)) : local.yearsExperience),
      );

      const level = this.normalizeLevel(parsed.level) || local.level;
      const prefersInternships =
        typeof parsed.prefersInternships === 'boolean' ? parsed.prefersInternships : local.prefersInternships;
      const englishLevel = this.normalizeEnglishLevel(parsed.englishLevel) || local.englishLevel;
      const preferredJobTypes = [...new Set([
        ...(Array.isArray(parsed.preferredJobTypes) ? parsed.preferredJobTypes : []).map((x: unknown) => String(x).trim().toLowerCase()).filter(Boolean),
        ...local.preferredJobTypes,
      ])].slice(0, 10);

      return {
        keywords: mergedKeywords,
        roles,
        yearsExperience,
        level,
        prefersInternships,
        englishLevel,
        preferredJobTypes,
      };
    } catch {
      return local;
    }
  }

  private async callModel(prompt: string, maxOutputTokens: number): Promise<string | null> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.key}`;

    try {
      const response = await axios.post(
        url,
        {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.45,
            topP: 0.95,
            maxOutputTokens,
          },
        },
        { timeout: 25000 },
      );

      const raw =
        response.data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || '').join('') || '';
      return raw || null;
    } catch {
      return null;
    }
  }

  private buildPrompt(input: GenerateInput): string {
    const premiumLine = input.isPremium
      ? 'Incluye recomendaciones premium para destacar en ATS y lenguaje de logros.'
      : 'Version free: conciso, util y directo.';

    return [
      'Eres un reclutador senior y especialista ATS.',
      'Debes responder SOLO con JSON valido con estas llaves:',
      '{"analysis":"...","cvText":"...","coverLetter":"...","keywords":["..."]}',
      premiumLine,
      `OFERTA TITULO: ${input.jobData.title}`,
      `EMPRESA: ${input.jobData.company}`,
      `KEYWORDS DETECTADAS: ${input.jobData.keywords.join(', ')}`,
      `CONTENIDO OFERTA: ${input.jobData.rawText.slice(0, 7000)}`,
      `CANDIDATO: ${input.candidate.fullName}`,
      `RESUMEN: ${input.candidate.profileSummary || 'No proporcionado'}`,
      `CV ANTERIOR: ${input.candidate.oldCvText || 'No proporcionado'}`,
      `EDUCACION: ${input.candidate.education || 'No proporcionado'}`,
      `SKILLS: ${input.candidate.skills || 'No proporcionado'}`,
      'La carta debe ser de 170-220 palabras en espanol (Peru).',
      'El CV debe estar optimizado para ATS con secciones claras y keywords de la oferta.',
    ].join('\n');
  }

  private parseResult(raw: string, fallbackKeywords: string[]) {
    try {
      const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      const parsed = JSON.parse(jsonText);

      return {
        analysis: String(parsed.analysis || '').trim(),
        cvText: String(parsed.cvText || '').trim(),
        coverLetter: String(parsed.coverLetter || '').trim(),
        keywords: Array.isArray(parsed.keywords) && parsed.keywords.length ? parsed.keywords : fallbackKeywords,
      };
    } catch {
      return {
        analysis: 'No se pudo parsear la salida IA. Se devolvio una version de respaldo.',
        cvText: raw.slice(0, 2500),
        coverLetter: 'No disponible temporalmente.',
        keywords: fallbackKeywords,
      };
    }
  }

  private fallback(input: GenerateInput) {
    const mainKeywords = input.jobData.keywords.slice(0, 8);
    return {
      analysis: `La oferta prioriza: ${mainKeywords.join(', ')}. Enfatiza resultados medibles, herramientas tecnicas y verbos de impacto para ATS.`,
      cvText: [
        `${input.candidate.fullName}`,
        'Perfil profesional:',
        input.candidate.profileSummary || 'Profesional en inicio de carrera, con alta capacidad de aprendizaje y enfoque en resultados.',
        '',
        'Competencias clave para esta vacante:',
        mainKeywords.join(', '),
        '',
        'Educacion:',
        input.candidate.education || 'Completar esta seccion con tu formacion.',
        '',
        'Habilidades tecnicas y blandas:',
        input.candidate.skills || 'Trabajo en equipo, comunicacion, gestion del tiempo.',
      ].join('\n'),
      coverLetter: `Estimado equipo de ${input.jobData.company}:\n\nMe interesa postular al puesto "${input.jobData.title}". Mi perfil combina ${mainKeywords.slice(0, 4).join(', ')} y una actitud orientada al aprendizaje rapido. Considero que puedo aportar valor inmediato por mi enfoque en resultados, orden y comunicacion efectiva.\n\nQuedo a disposicion para ampliar mi informacion en entrevista.\n\nAtentamente,\n${input.candidate.fullName}`,
      keywords: mainKeywords,
    };
  }

  private fallbackKeywords(cvText: string, desiredRole?: string): string[] {
    const blacklist = new Set([
      'para',
      'como',
      'desde',
      'hasta',
      'sobre',
      'anios',
      'nivel',
      'trabajo',
      'experiencia',
      'proyecto',
      'titulo',
      'descripcion',
      'descripci',
      'desarrollo',
      'club',
      'deportivo',
    ]);

    const freq = new Map<string, number>();
    const words = cvText
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .match(/[a-z0-9+#.]{4,}/g) || [];

    for (const w of words) {
      if (blacklist.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }

    const auto = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([w]) => w);

    const base = desiredRole ? [desiredRole, ...auto] : auto;
    if (!base.length) {
      return ['practicante', 'asistente administrativo', 'analista', 'atencion al cliente'];
    }
    return base.slice(0, 12);
  }

  private postProcessKeywords(list: string[], desiredRole?: string): string[] {
    const noise = new Set(['proyecto', 'club', 'deportivo', 'titulo', 'descripcion', 'descripci', 'desarrollo', '2022']);

    const cleaned = list
      .map((x) =>
        String(x)
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9+#.\s-]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter((x) => x && x.length >= 3 && !noise.has(x));

    const uniq = [...new Set(cleaned)];
    const withRole = desiredRole ? [desiredRole.toLowerCase(), ...uniq] : uniq;

    const finalList = [...new Set(withRole)].slice(0, 24);
    if (!finalList.length) {
      return ['practicante', 'asistente', 'analista', 'comercial'];
    }
    return finalList;
  }

  private buildCvExcerpt(fullText: string): string {
    if (fullText.length <= 36000) return fullText;

    const chunk = 12000;
    const head = fullText.slice(0, chunk);
    const middleStart = Math.max(Math.floor(fullText.length / 2) - Math.floor(chunk / 2), 0);
    const middle = fullText.slice(middleStart, middleStart + chunk);
    const tail = fullText.slice(-chunk);

    return [head, middle, tail].join('\n');
  }

  private buildLocalInsights(cvText: string, desiredRole: string | undefined, localKeywords: string[]): CvInsights {
    const normalized = cvText
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    const yearsMatches = [...normalized.matchAll(/(\d{1,2})\s*(?:\+)?\s*(?:anos|ano|years|year)/g)].map((m) => Number(m[1]));
    const yearsExperience = yearsMatches.length ? Math.max(...yearsMatches.filter((n) => !Number.isNaN(n))) : 0;

    const entrySignals = ['practicante', 'practica', 'intern', 'trainee', 'sin experiencia', 'estudiante'];
    const seniorSignals = ['senior', 'lead', 'lider', 'manager', 'jefe', 'principal', 'arquitecto'];
    const entryHits = entrySignals.filter((x) => normalized.includes(x)).length;
    const seniorHits = seniorSignals.filter((x) => normalized.includes(x)).length;

    let level: CvInsights['level'] = 'mid';
    if (yearsExperience <= 1 || entryHits >= 2) level = 'intern';
    else if (yearsExperience <= 3 || entryHits > 0) level = 'junior';
    else if (yearsExperience >= 6 || seniorHits >= 2) level = 'senior';

    const prefersInternships = level === 'intern' || (level === 'junior' && yearsExperience <= 1);

    let englishLevel: CvInsights['englishLevel'] = 'unknown';
    if (/\b(c1|c2|advanced english|ingles avanzado|fluent|bilingue)\b/.test(normalized)) englishLevel = 'advanced';
    else if (/\b(b1|b2|intermediate english|ingles intermedio)\b/.test(normalized)) englishLevel = 'intermediate';
    else if (/\b(a1|a2|ingles basico|basic english)\b/.test(normalized)) englishLevel = 'basic';

    const preferredJobTypes = prefersInternships
      ? ['practica', 'intern', 'trainee', 'junior']
      : level === 'senior'
        ? ['tiempo completo', 'senior', 'lead']
        : ['tiempo completo', 'junior', 'analista'];

    return {
      keywords: this.postProcessKeywords(localKeywords, desiredRole),
      roles: desiredRole ? [desiredRole.toLowerCase()] : localKeywords.slice(0, 4),
      yearsExperience,
      level,
      prefersInternships,
      englishLevel,
      preferredJobTypes,
    };
  }

  private normalizeLevel(value: unknown): CvInsights['level'] | null {
    const v = String(value || '').toLowerCase().trim();
    if (v === 'intern' || v === 'junior' || v === 'mid' || v === 'senior') return v;
    return null;
  }

  private normalizeEnglishLevel(value: unknown): CvInsights['englishLevel'] | null {
    const v = String(value || '').toLowerCase().trim();
    if (v === 'basic' || v === 'intermediate' || v === 'advanced' || v === 'unknown') return v;
    return null;
  }
}
