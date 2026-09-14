/**
 * Supported solution languages, in display order.
 *
 * Single source of truth: the selector renders from this, and the queue's
 * cycle-to-next-language control reads from it. Previously the queue rendered
 * a hidden copy of the selector off-screen just to scrape its <option> values.
 */
export interface LanguageOption {
  id: string
  name: string
}

export const LANGUAGES: LanguageOption[] = [
  { id: "python", name: "Python" },
  { id: "javascript", name: "JavaScript" },
  { id: "java", name: "Java" },
  { id: "golang", name: "Go" },
  { id: "cpp", name: "C++" },
  { id: "swift", name: "Swift" },
  { id: "kotlin", name: "Kotlin" },
  { id: "ruby", name: "Ruby" },
  { id: "sql", name: "SQL" },
  { id: "r", name: "R" }
]

export function languageName(id: string): string {
  return LANGUAGES.find((l) => l.id === id)?.name ?? id
}

/** Next/previous language, wrapping around. */
export function adjacentLanguage(current: string, direction: "next" | "prev"): string {
  const index = LANGUAGES.findIndex((l) => l.id === current)
  if (index === -1) return LANGUAGES[0].id
  const delta = direction === "prev" ? -1 : 1
  return LANGUAGES[(index + delta + LANGUAGES.length) % LANGUAGES.length].id
}
