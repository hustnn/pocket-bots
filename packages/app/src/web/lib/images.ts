/** Pictures are stored with the bot in bots.json, so they're scaled down to this many pixels. */
export const PICTURE_SIZE = 256;

/** A picture cropped to its centre square and scaled to `size`, as a WebP data URL. */
export function squareImage(source: string, size = PICTURE_SIZE): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      if (!side || !context) return reject(new Error("That picture couldn't be read."));
      context.imageSmoothingQuality = "high";
      context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      resolve(canvas.toDataURL("image/webp", 0.85));
    };
    image.onerror = () => reject(new Error("Couldn't read the picture."));
    image.src = source;
  });
}
