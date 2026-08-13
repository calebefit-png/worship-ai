"""Converte o htdemucs.onnx para IR <= 10 e opset <= 16, compatível com
onnxruntime-node 1.x (max IR 10). O modelo usa operadores padrão; se algum
operador exigir opset > 16, o version_converter tentará a conversão e
falhará explicitamente, o que nos diz exatamente o que falta."""

import onnx
from onnx import version_converter

SRC = '/home/ubuntu/worship-ai/Moises_v2/models/htdemucs.onnx'
DST = '/home/ubuntu/worship-ai/Moises_v2/models/htdemucs-ort.onnx'

model = onnx.load(SRC)
print('Original: IR', model.ir_version, '| opsets:',
      [(o.domain or 'ai.onnx', o.version) for o in model.opset_import])

# Opset 16 falha (LayerNormalization só existe em opset 17). Testar se o ORT
# consegue carregar o modelo original com apenas o IR ajustado; se o nó do ORT
# ainda rejeitar opset 17, a alternativa é baixar uma versão mais recente do
# onnxruntime-node que suporte opset 17.
model.ir_version = 8  # já era 8; manter compatível
onnx.save(model, DST)
print('Salvo (mesma versão IR/opset):', DST)
