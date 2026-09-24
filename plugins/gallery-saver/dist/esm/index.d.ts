export interface SaveImageOptions {
  data: string;
  filename: string;
  mimeType?: string;
  replaceIdentifier?: string;
}

export interface SaveImageResult {
  uri: string;
}

export interface GallerySaverPlugin {
  saveImage(options: SaveImageOptions): Promise<SaveImageResult>;
}

export declare const GallerySaver: GallerySaverPlugin;
