export interface OntologyChangelogEntry {
    version: string;
    /** ISO date (YYYY-MM-DD). */
    date: string;
    changes: string[];
}
export declare const CHANGELOG: readonly OntologyChangelogEntry[];
export declare const ONTOLOGY_VERSION: string;
