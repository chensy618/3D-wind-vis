#!/bin/bash
#SBATCH --account=nn8106k
#SBATCH --partition=accel
#SBATCH --job-name=aurora01_senja
#SBATCH --time=01:00:00
#SBATCH --mem=200G
#SBATCH --gpus-per-node=1
#SBATCH --cpus-per-task=8
#SBATCH --output=jobs/logs/%x_%j.out
#SBATCH --error=jobs/logs/%x_%j.err

# Aurora 0.1° on a GH200 node. Inputs must be fetched first on the login node:
#   python model/aurora01_inference.py --fetch-only
#   sbatch jobs/run_aurora01_senja.slurm                    # default init 2024-01-31T06
#   sbatch jobs/run_aurora01_senja.slurm 2024-01-31T06

set -euo pipefail

INIT_TIME=${1:-2024-01-31T06}

module --force purge
module load NRIS/GPU
module load Python/3.11.5-GCCcore-13.2.0
module load CUDA/13.0.0

# torch + cfgrib from the earth2studio venv; microsoft-aurora (pure Python) from its own directory
source /cluster/projects/nn8106k/siyan/envs/earth2studio/bin/activate
export PYTHONPATH=/cluster/work/projects/nn8106k/siyan/pylib/aurora:${PYTHONPATH:-}
export CUDA_HOME=${EBROOTCUDA:-$(dirname $(dirname $(which nvcc)))}
export LD_LIBRARY_PATH=$CUDA_HOME/lib64:${LD_LIBRARY_PATH:-}

cd "${SLURM_SUBMIT_DIR}"
echo "node $(hostname)  init ${INIT_TIME}  $(date)"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

python -u model/aurora01_inference.py --init-time "${INIT_TIME}" --nsteps 4

echo "done $(date)"
