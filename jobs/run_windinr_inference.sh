#!/bin/bash
# WindINR inference for one forecast driver inside LUMI's PyTorch container (CPU is enough:
# ~46k query points x 5 lead times). Run from the repo root after
#   python preprocessing/convert_windinr.py prep --driver <driver>
#   jobs/run_windinr_inference.sh aurora01 [ckpt]
set -euo pipefail
DRIVER=${1:-aurora01}
WINDINR=$(cd .. && pwd)/windinr
CKPT=${2:-$WINDINR/ckpts/senja_v1/v3/stage2_bg.pt}
SIF=/appl/local/containers/sif-images/lumi-pytorch-rocm-6.2.4-python-3.12-pytorch-v2.7.1.sif
singularity exec -B /pfs/lustrep4/scratch/project_465003463 "$SIF" python model/windinr_inference.py \
    --windinr "$WINDINR" --ckpt "$CKPT" --terrain-dir "$WINDINR/dataset/senja_v1_65case_ceiling500_backup" \
    --inputs data/windinr/${DRIVER}_inputs.npz --out data/windinr/${DRIVER}_pred.npz
