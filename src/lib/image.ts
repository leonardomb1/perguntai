const MAX_DIMENSION = 2048;
const MAX_RAW_BYTES = 2_500_000;

/**
 * File → data URL for sending to the model. Large images are downscaled to
 * 2048px and re-encoded as JPEG so a pasted 4K screenshot doesn't blow up the
 * request body (and image tokens); small ones pass through untouched so
 * screenshots with text stay crisp.
 */
export async function imageToDataUrl(file: File): Promise<string> {
	const bitmap = await createImageBitmap(file);
	const oversized = Math.max(bitmap.width, bitmap.height) > MAX_DIMENSION;

	if (!oversized && file.size <= MAX_RAW_BYTES) {
		bitmap.close();
		return await new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result as string);
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}

	const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement('canvas');
	canvas.width = Math.round(bitmap.width * scale);
	canvas.height = Math.round(bitmap.height * scale);
	canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close();
	return canvas.toDataURL('image/jpeg', 0.85);
}
