"""Make ConvInteger nodes runnable on ONNX Runtime CPU: int8 weights -> uint8.

ConvInteger computes (x - x_zp) * (w - w_zp). Adding 128 to both w and w_zp
keeps every difference identical, so the output does not change.
"""
import sys
import numpy as np
import onnx
from onnx import numpy_helper

src, dst = sys.argv[1], sys.argv[2]
model = onnx.load(src)
inits = {i.name: i for i in model.graph.initializer}
done = set()
nodes = [n for n in model.graph.node if n.op_type == "ConvInteger"]
print("ConvInteger nodes:", len(nodes))
for node in nodes:
    w_name = node.input[1]
    zp_name = node.input[3] if len(node.input) > 3 and node.input[3] else None
    for name in filter(None, [w_name, zp_name]):
        if name in done:
            continue
        init = inits[name]
        arr = numpy_helper.to_array(init)
        if arr.dtype == np.int8:
            fixed = (arr.astype(np.int16) + 128).astype(np.uint8)
            init.CopyFrom(numpy_helper.from_array(fixed, name))
        done.add(name)
    if zp_name is None:
        # Missing zero point means 0 for int8; uint8 needs 128 explicitly.
        name = w_name + "_zp_u8"
        model.graph.initializer.append(numpy_helper.from_array(np.array(128, dtype=np.uint8), name))
        while len(node.input) < 4:
            node.input.append("")
        node.input[3] = name
print("initializers converted:", len(done))
onnx.save(model, dst)
