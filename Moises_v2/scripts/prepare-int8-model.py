"""Prepara o HT-Demucs INT8 durante o build para caber no plano Render de 512 MiB.

O arquivo FP32 é baixado apenas no ambiente de build, quantizado de forma
atômica e excluído em seguida. No runtime, somente htdemucs.int8.onnx fica
presente, evitando download e picos adicionais de armazenamento/memória.
"""
from pathlib import Path
from urllib.request import Request, urlopen
from onnxruntime.quantization import QuantType, quantize_dynamic

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "models"
TARGET = MODELS / "htdemucs.int8.onnx"
SOURCE = MODELS / "htdemucs.fp32.source.onnx"
TEMP_SOURCE = MODELS / "htdemucs.fp32.source.onnx.download"
TEMP_TARGET = MODELS / "htdemucs.int8.onnx.build"
URL = "https://huggingface.co/MrCitron/demucs-v4-onnx/resolve/main/htdemucs.onnx"
MIN_BYTES = 100_000_000


def is_complete(path: Path) -> bool:
    return path.exists() and path.stat().st_size >= MIN_BYTES


def download_model() -> None:
    print(f"Baixando HT-Demucs FP32 para {TEMP_SOURCE}...")
    request = Request(URL, headers={"User-Agent": "WorshipAI-build/1.0"})
    with urlopen(request, timeout=120) as response, TEMP_SOURCE.open("wb") as output:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)
    if not is_complete(TEMP_SOURCE):
        raise RuntimeError(f"Download do modelo incompleto: {TEMP_SOURCE.stat().st_size if TEMP_SOURCE.exists() else 0} bytes")
    TEMP_SOURCE.replace(SOURCE)


def main() -> None:
    MODELS.mkdir(parents=True, exist_ok=True)
    if is_complete(TARGET):
        print(f"Modelo INT8 já disponível: {TARGET} ({TARGET.stat().st_size} bytes)")
        return

    TEMP_SOURCE.unlink(missing_ok=True)
    TEMP_TARGET.unlink(missing_ok=True)
    if not is_complete(SOURCE):
        SOURCE.unlink(missing_ok=True)
        download_model()

    try:
        print("Quantizando pesos do HT-Demucs para INT8...")
        quantize_dynamic(
            model_input=str(SOURCE),
            model_output=str(TEMP_TARGET),
            weight_type=QuantType.QInt8,
            op_types_to_quantize=["MatMul", "Gemm", "Conv"],
            per_channel=True,
            reduce_range=False,
        )
        if not is_complete(TEMP_TARGET):
            raise RuntimeError(f"Modelo INT8 inválido: {TEMP_TARGET.stat().st_size if TEMP_TARGET.exists() else 0} bytes")
        TEMP_TARGET.replace(TARGET)
        print(f"Modelo INT8 pronto: {TARGET} ({TARGET.stat().st_size} bytes)")
    finally:
        # O artefato FP32 não deve ir para o runtime, que possui apenas 512 MiB.
        SOURCE.unlink(missing_ok=True)
        TEMP_SOURCE.unlink(missing_ok=True)
        TEMP_TARGET.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
