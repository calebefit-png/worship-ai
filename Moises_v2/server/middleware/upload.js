const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  }
});

// Aceita extensões e MIME types de MP3/WAV; extensões em minúsculas para
// evitar variações (ex.: .WAV, .Mp3) e MIME sem "x-" legacy.
const ALLOWED_EXTS = ['.mp3', '.wav'];
const ALLOWED_MIMES = ['audio/mpeg', 'audio/wav', 'audio/x-wav'];

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const extOk = ALLOWED_EXTS.includes(ext);
  const mimeOk = ALLOWED_MIMES.includes(file.mimetype);

  // A extensão é a regra primária: clientes (curl, alguns navegadores e
  // libs) às vezes enviam "application/octet-stream" mesmo para MP3/WAV.
  // O mimetype é rejeitado apenas se estiver presente e explicitamente
  // proibido (ex.: "image/png"), não quando é o genérico octet-stream.
  const mimeProhibited =
    file.mimetype &&
    file.mimetype !== 'application/octet-stream' &&
    !mimeOk;

  if (extOk && !mimeProhibited) {
    cb(null, true);
  } else {
    cb(new Error('Formato de arquivo inválido. Apenas MP3 e WAV são permitidos.'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

module.exports = upload;
