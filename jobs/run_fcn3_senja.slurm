#!/bin/bash
#SBATCH --account=nn8106k
#SBATCH --partition=accel
#SBATCH --job-name=fcn3_senja
#SBATCH --time=01:00:00
#SBATCH --mem=128G
#SBATCH --gpus-per-node=1
#SBATCH --cpus-per-task=4
#SBATCH --output=jobs/logs/%x_%j.out
#SBATCH --error=jobs/logs/%x_%j.err

# Usage (from the repo root):
#   sbatch jobs/run_fcn3_senja.slurm                       # default init time
#   sbatch jobs/run_fcn3_senja.slurm 2024-01-31T06:00:00 cds

set -euo pipefail

INIT_TIME=${1:-2024-01-31T06:00:00}
SOURCE=${2:-cds}

module --force purge
module load NRIS/GPU
module load Python/3.11.5-GCCcore-13.2.0
module load CUDA/13.0.0

source /cluster/projects/nn8106k/siyan/envs/earth2studio/bin/activate
[ -f ~/.ngc_env ] && source ~/.ngc_env

export CUDA_HOME=${EBROOTCUDA:-$(dirname $(dirname $(which nvcc)))}
export LD_LIBRARY_PATH=$CUDA_HOME/lib64:${LD_LIBRARY_PATH:-}
export EARTH2STUDIO_CACHE=/cluster/work/projects/nn8106k/siyan/earth2studio_cache
export EARTH2STUDIO_DATA_CACHE=$EARTH2STUDIO_CACHE/data
export EARTH2STUDIO_MODEL_CACHE=$EARTH2STUDIO_CACHE/models

cd "${SLURM_SUBMIT_DIR}"
echo "node $(hostname)  init ${INIT_TIME}  source ${SOURCE}  $(date)"

python -u model/fcn3_inference.py --init-time "${INIT_TIME}" --nsteps 4 --source "${SOURCE}"

echo "done $(date)"
