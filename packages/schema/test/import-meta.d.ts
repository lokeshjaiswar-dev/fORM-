/* Vite's import.meta.glob, as the schema tests use it (the package does not depend on vite's client types). */
interface ImportMeta { glob<T>(pattern: string, options: { eager: true; import: 'default' }): Record<string, T> }
