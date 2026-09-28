/**
 * gfxstrings.js — localized strings for the Graphics settings section.
 * The locale comes from navigator.language (the game has no language
 * setting); unknown locales fall back by language, then to en-US.
 */

const EN = {
  quality: 'Quality',
  auto: 'Auto (detected: {tier})',
  renderScale: 'Render scale',
  fromPreset: 'From preset ({tier})',
  adaptive: 'Adaptive resolution (lower the resolution when frames are slow)',
  showFps: 'Show frame rate',
  postNote: 'Post-processing is unavailable on this device, so the game renders without it.',
  hint: 'Changes apply immediately. Effects never alter rules or hide hazards.',
  presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
  cats: {
    shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Lantern glow (bloom)', grade: 'Color grade',
    antialias: 'Anti-aliasing', reflections: 'Reflections', detail: 'Surface detail',
    particles: 'Particles', ambience: 'Ambient motion',
  },
  tiers: {
    off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Plain', detailed: 'Detailed', static: 'Static', animated: 'Animated',
  },
};

const GB = {
  ...EN,
  cats: { ...EN.cats, grade: 'Colour grade' },
};

const ES = {
  quality: 'Calidad',
  auto: 'Automática (detectada: {tier})',
  renderScale: 'Escala de renderizado',
  fromPreset: 'Según el ajuste ({tier})',
  adaptive: 'Resolución adaptativa (baja la resolución si los fotogramas van lentos)',
  showFps: 'Mostrar fotogramas por segundo',
  postNote: 'El posprocesado no está disponible en este dispositivo; el juego se muestra sin él.',
  hint: 'Los cambios se aplican al instante. Los efectos nunca alteran las reglas ni ocultan peligros.',
  presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  cats: {
    shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Brillo de farolillos (bloom)', grade: 'Gradación de color',
    antialias: 'Antialiasing', reflections: 'Reflejos', detail: 'Detalle de superficies',
    particles: 'Partículas', ambience: 'Movimiento ambiental',
  },
  tiers: {
    off: 'No', on: 'Sí', low: 'Baja', medium: 'Media', high: 'Alta',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Simple', detailed: 'Detallado', static: 'Estático', animated: 'Animado',
  },
};

const ES_419 = {
  ...ES,
  cats: { ...ES.cats, bloom: 'Brillo de faroles (bloom)' },
};

const DE = {
  quality: 'Qualität',
  auto: 'Automatisch (erkannt: {tier})',
  renderScale: 'Renderskalierung',
  fromPreset: 'Laut Voreinstellung ({tier})',
  adaptive: 'Adaptive Auflösung (senkt die Auflösung bei langsamen Bildern)',
  showFps: 'Bildrate anzeigen',
  postNote: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; das Spiel wird ohne sie dargestellt.',
  hint: 'Änderungen wirken sofort. Effekte ändern nie die Regeln und verdecken keine Gefahren.',
  presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
  cats: {
    shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Laternenschein (Bloom)', grade: 'Farbkorrektur',
    antialias: 'Kantenglättung', reflections: 'Spiegelungen', detail: 'Oberflächendetails',
    particles: 'Partikel', ambience: 'Umgebungsbewegung',
  },
  tiers: {
    off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Schlicht', detailed: 'Detailliert', static: 'Statisch', animated: 'Animiert',
  },
};

const FR = {
  quality: 'Qualité',
  auto: 'Auto (détectée : {tier})',
  renderScale: 'Échelle de rendu',
  fromPreset: 'Selon le préréglage ({tier})',
  adaptive: 'Résolution adaptative (baisse la résolution si les images ralentissent)',
  showFps: 'Afficher la fréquence d’images',
  postNote: 'Le post-traitement n’est pas disponible sur cet appareil ; le jeu s’affiche sans lui.',
  hint: 'Les changements s’appliquent immédiatement. Les effets ne modifient jamais les règles et ne masquent aucun danger.',
  presets: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
  cats: {
    shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo des lanternes (bloom)', grade: 'Étalonnage des couleurs',
    antialias: 'Anticrénelage', reflections: 'Reflets', detail: 'Détail des surfaces',
    particles: 'Particules', ambience: 'Mouvement d’ambiance',
  },
  tiers: {
    off: 'Non', on: 'Oui', low: 'Basse', medium: 'Moyenne', high: 'Haute',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Simple', detailed: 'Détaillé', static: 'Statique', animated: 'Animé',
  },
};

const FR_CA = {
  ...FR,
  showFps: 'Afficher le nombre d’images par seconde',
  cats: { ...FR.cats, antialias: 'Antialiasing' },
};

const PT_BR = {
  quality: 'Qualidade',
  auto: 'Automática (detectada: {tier})',
  renderScale: 'Escala de renderização',
  fromPreset: 'Conforme a predefinição ({tier})',
  adaptive: 'Resolução adaptativa (reduz a resolução quando os quadros ficam lentos)',
  showFps: 'Mostrar taxa de quadros',
  postNote: 'O pós-processamento não está disponível neste dispositivo; o jogo é exibido sem ele.',
  hint: 'As mudanças valem na hora. Os efeitos nunca alteram as regras nem escondem perigos.',
  presets: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  cats: {
    shadows: 'Sombras', ao: 'Oclusão de ambiente', bloom: 'Brilho das lanternas (bloom)', grade: 'Correção de cor',
    antialias: 'Antisserrilhado', reflections: 'Reflexos', detail: 'Detalhe das superfícies',
    particles: 'Partículas', ambience: 'Movimento ambiente',
  },
  tiers: {
    off: 'Desligado', on: 'Ligado', low: 'Baixa', medium: 'Média', high: 'Alta',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Simples', detailed: 'Detalhado', static: 'Estático', animated: 'Animado',
  },
};

const IT = {
  quality: 'Qualità',
  auto: 'Automatica (rilevata: {tier})',
  renderScale: 'Scala di rendering',
  fromPreset: 'Da preimpostazione ({tier})',
  adaptive: 'Risoluzione adattiva (abbassa la risoluzione quando i fotogrammi rallentano)',
  showFps: 'Mostra frequenza fotogrammi',
  postNote: 'La post-elaborazione non è disponibile su questo dispositivo; il gioco viene mostrato senza.',
  hint: 'Le modifiche si applicano subito. Gli effetti non cambiano mai le regole né nascondono pericoli.',
  presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
  cats: {
    shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore delle lanterne (bloom)', grade: 'Correzione colore',
    antialias: 'Anti-aliasing', reflections: 'Riflessi', detail: 'Dettaglio superfici',
    particles: 'Particelle', ambience: 'Movimento ambientale',
  },
  tiers: {
    off: 'No', on: 'Sì', low: 'Bassa', medium: 'Media', high: 'Alta',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Semplice', detailed: 'Dettagliato', static: 'Statico', animated: 'Animato',
  },
};

export const GFX_STRINGS = {
  'en-US': EN, 'en-GB': GB, 'es-419': ES_419, 'es-ES': ES, 'de-DE': DE,
  'fr-FR': FR, 'fr-CA': FR_CA, 'pt-BR': PT_BR, 'it-IT': IT,
};

const BY_LANG = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

/** Strings for a BCP-47 tag (defaults to the browser language). */
export function gfxStrings(tag = (typeof navigator !== 'undefined' && navigator.language) || 'en-US') {
  const t = String(tag);
  const exact = Object.keys(GFX_STRINGS).find((k) => k.toLowerCase() === t.toLowerCase());
  if (exact) return GFX_STRINGS[exact];
  const lang = t.split('-')[0].toLowerCase();
  if (lang === 'en' && /-(gb|ie|au|nz|za|in)$/i.test(t)) return GB;
  if (lang === 'es' && /-es$/i.test(t)) return ES;
  return GFX_STRINGS[BY_LANG[lang]] || EN;
}

/** Fill "{tier}"-style placeholders. */
export function fmt(str, vars) {
  return String(str).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}
