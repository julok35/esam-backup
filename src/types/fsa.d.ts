/*
 * Compléments de types pour l'API File System Access (Chrome Android).
 *
 * Les types lib.dom de TypeScript 7.0 couvrent déjà FileSystemDirectoryHandle.values(),
 * entries(), keys(), getFileHandle(), getDirectoryHandle() et createWritable().
 * Ils ne couvrent pas showDirectoryPicker(), queryPermission(), requestPermission()
 * ni move(), qui sont ajoutés ici. Vérifié avec tsc, ne pas dupliquer ce qui existe.
 */

export {};

declare global {
  type FileSystemPermissionMode = 'read' | 'readwrite';

  interface FileSystemHandlePermissionDescriptor {
    mode?: FileSystemPermissionMode;
  }

  interface FileSystemHandle {
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    /** Absent ou limité selon les navigateurs et les systèmes de fichiers : toujours tester. */
    move?(newName: string): Promise<void>;
    move?(destination: FileSystemDirectoryHandle, newName?: string): Promise<void>;
  }

  type WellKnownDirectory = 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';

  interface DirectoryPickerOptions {
    id?: string;
    mode?: FileSystemPermissionMode;
    startIn?: WellKnownDirectory | FileSystemHandle;
  }

  interface Window {
    showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  }
}
