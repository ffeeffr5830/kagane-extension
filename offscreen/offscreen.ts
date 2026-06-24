import { jsPDF } from 'jspdf';

interface ImagePayload {
  base64: string;
  mimeType: string;
}

interface GeneratePdfMessage {
  type: string;
  payload?: {
    images: ImagePayload[];
    title: string;
  };
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    // @ts-ignore
    binary += String.fromCharCode.apply(null, sub);
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const msg = message as GeneratePdfMessage;
  if (msg.type === 'offscreen:generate-pdf') {
    if (!msg.payload) {
      sendResponse({ ok: false, error: 'No payload provided' });
      return true;
    }
    const { images } = msg.payload;
    generatePdf(images)
      .then((pdfBase64) => {
        sendResponse({ ok: true, data: pdfBase64 });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      });
    return true; // async response
  }
});

async function generatePdf(images: ImagePayload[]): Promise<string> {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'px',
    format: 'a4',
    compress: true,
  });

  let isFirstPage = true;

  for (const imgData of images) {
    const bytes = base64ToUint8Array(imgData.base64);
    const blob = new Blob([bytes], { type: imgData.mimeType });
    const blobUrl = URL.createObjectURL(blob);

    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.src = blobUrl;
        image.onload = () => resolve(image);
        image.onerror = (e) => reject(new Error('Failed to load image in offscreen: ' + String(e)));
      });

      const imgWidth = img.naturalWidth;
      const imgHeight = img.naturalHeight;

      // Draw to canvas to convert to JPEG (WebP to JPEG conversion for PDF compatibility)
      const canvas = document.createElement('canvas');
      canvas.width = imgWidth;
      canvas.height = imgHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Canvas 2D context not available');
      }
      ctx.drawImage(img, 0, 0);
      const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.9);

      if (isFirstPage) {
        isFirstPage = false;
        // doc starts with 1 default page. Delete it and add matching size page.
        doc.deletePage(1);
        doc.addPage([imgWidth, imgHeight], imgWidth > imgHeight ? 'landscape' : 'portrait');
      } else {
        doc.addPage([imgWidth, imgHeight], imgWidth > imgHeight ? 'landscape' : 'portrait');
      }

      doc.addImage(jpegDataUrl, 'JPEG', 0, 0, imgWidth, imgHeight);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  const pdfBuffer = doc.output('arraybuffer');
  return arrayBufferToBase64(pdfBuffer);
}
