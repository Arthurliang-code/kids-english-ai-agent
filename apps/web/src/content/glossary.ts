import entries from '../../../../content/words.json' with { type: 'json' };
import { findGlossaryEntry, type GlossaryEntry } from '../domain/glossary';
import { lemmaCandidates } from '../domain/lexicon';

export function lookupGlossary(word: string): GlossaryEntry | null {
  return findGlossaryEntry(entries, word, lemmaCandidates(word));
}
