/**
 * Finds the Playwright report inside a downloaded artifacts folder: a JSON
 * report (has "suites" and "config") or a blob-report folder (report-*.zip).
 */
export interface FoundReport {
    report: string;
    kind: 'json' | 'blob';
    traceDirs: string[];
}
export declare function findReport(dir: string, maxDepth?: number): Promise<FoundReport | null>;
