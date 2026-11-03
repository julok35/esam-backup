export interface TypoIssue {
  line: number;
  column: number;
  label: string;
}
export interface FileTypoIssue extends TypoIssue {
  file: string;
}
export declare const FORBIDDEN: ReadonlyArray<{ char: string; label: string }>;
export declare function looksBinary(buffer: Uint8Array): boolean;
export declare function findTypoIssues(text: string): TypoIssue[];
export declare function listRepoFiles(cwd?: string): string[];
export declare function checkFiles(files: readonly string[], cwd?: string): FileTypoIssue[];
