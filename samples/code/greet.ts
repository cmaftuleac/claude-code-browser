/**
 * Tiny TypeScript sample — open in the editor to verify syntax highlighting,
 * folding, and the source-mode toolbar.
 */

export interface Greeting {
  name: string;
  language?: 'en' | 'fr' | 'de' | 'ja';
}

const GREETINGS: Record<NonNullable<Greeting['language']>, string> = {
  en: 'Hello',
  fr: 'Bonjour',
  de: 'Hallo',
  ja: 'こんにちは',
};

export function greet({ name, language = 'en' }: Greeting): string {
  const word = GREETINGS[language];
  return `${word}, ${name}!`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(greet({ name: 'Avery' }));
  console.log(greet({ name: 'Léa', language: 'fr' }));
}
