import { fileToDataUrl } from "./storage";

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片读取失败"));
    image.src = url;
  });

export const removeFlatBackground = async (
  file: File,
  tolerance = 48,
): Promise<string> => {
  const sourceUrl = await fileToDataUrl(file);
  const image = await loadImage(sourceUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return sourceUrl;
  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  const samples = [
    [0, 0],
    [canvas.width - 1, 0],
    [0, canvas.height - 1],
    [canvas.width - 1, canvas.height - 1],
  ].map(([x, y]) => {
    const index = (y * canvas.width + x) * 4;
    return [pixels[index], pixels[index + 1], pixels[index + 2]];
  });
  const key = samples
    .reduce(
      (sum, sample) => [
        sum[0] + sample[0] / samples.length,
        sum[1] + sample[1] / samples.length,
        sum[2] + sample[2] / samples.length,
      ],
      [0, 0, 0],
    )
    .map(Math.round);

  for (let index = 0; index < pixels.length; index += 4) {
    const colorDistance = Math.hypot(
      pixels[index] - key[0],
      pixels[index + 1] - key[1],
      pixels[index + 2] - key[2],
    );
    if (colorDistance <= tolerance) {
      pixels[index + 3] = Math.round((colorDistance / tolerance) * 60);
    } else if (colorDistance <= tolerance * 1.8) {
      pixels[index + 3] = Math.min(
        pixels[index + 3],
        Math.round(((colorDistance - tolerance) / (tolerance * 0.8)) * 255),
      );
    }
  }
  context.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
};
