#!/bin/bash
#SBATCH --account=nn8106k
#SBATCH --partition=accel
#SBATCH --job-name=graphcast_senja
#SBATCH --time=01:00:00
#SBATCH --mem=128G
#SBATCH --gpus-per-node=1
#SBATCH --cpus-per-task=8
#SBATCH --output=jobs/logs/%x_%j.out
#SBATCH --error=jobs/logs/%x_%j.err

# GraphCast 0.25° on a GH200 node (JAX). Inputs must be fetched first on the login node:
#   python model/graphcast_inference.py --fetch-only
#   sbatch jobs/run_graphcast_senja.slurm                   # default init 2024-01-31T06
#   sbatch jobs/run_graphcast_senja.slurm 2024-01-31T06

set -euo pipefail

INIT_TIME=${1:-2024-01-31T06}

module --force purge
module load NRIS/GPU
module load Python/3.11.5-GCCcore-13.2.0
module load CUDA/13.0.0

# jax[cuda13] + dm-haiku + graphcast (pinned commit) live in this venv
source /cluster/projects/nn8106k/siyan/envs/earth2studio-graphcast/bin/activate
export XLA_PYTHON_CLIENT_PREALLOCATE=false

cd "${SLURM_SUBMIT_DIR}"
echo "node $(hostname)  init ${INIT_TIME}  $(date)"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

python -u model/graphcast_inference.py --init-time "${INIT_TIME}" --nsteps 4

echo "done $(date)"
