"""Run a WindINR background-mode checkpoint on prepared inputs (one background per lead time).

Inputs come from preprocessing/convert_windinr.py prep; runs where torch and the windinr
package are available (on LUMI: the PyTorch container, see jobs/run_windinr_inference.sh).
Uses the same encode/decode path as windinr/scripts/predict_case.py.

    python model/windinr_inference.py --windinr ../windinr --ckpt ../windinr/ckpts/senja_v1/v3/stage2_bg.pt \\
        --terrain-dir ../windinr/dataset/senja_v1_65case_ceiling500_backup \\
        --inputs data/windinr/aurora01_inputs.npz --out data/windinr/aurora01_pred.npz
"""

import argparse
import json
import sys

import numpy as np
import torch


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--windinr", required=True, help="windinr repository (for the windinr package)")
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--terrain-dir", required=True)
    ap.add_argument("--inputs", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--chunk", type=int, default=65536)
    args = ap.parse_args()
    sys.path.insert(0, args.windinr)
    from windinr.datasets import BaseWindDataset
    from windinr.models import LatentWindINR, get_model_kwargs_from_ckpt

    ckpt = torch.load(args.ckpt, map_location="cpu", weights_only=False)
    model = LatentWindINR(**get_model_kwargs_from_ckpt(ckpt))
    model.load_state_dict(ckpt["model"], strict=False)
    model.eval()

    # terrain features and point -> background-grid mapping exactly as in training
    helper = BaseWindDataset.__new__(BaseWindDataset)
    helper.terrain_cache = BaseWindDataset._build_terrain_cache(args.terrain_dir)
    inp = np.load(args.inputs)
    points = inp["points"].astype(np.float32)
    meta = json.loads(str(inp["lowres_meta"]))
    points_lr = helper._points_to_lowres_norm(points, meta)
    terrain = torch.from_numpy(helper.terrain_cache.terrain_in)[None]
    p_all, plr_all = torch.from_numpy(points), torch.from_numpy(points_lr)

    preds = []
    with torch.no_grad():
        for t, uv in enumerate(inp["lowres_uv"]):
            valid = np.isfinite(uv).all(axis=-1).astype(np.float32)
            lowres = np.concatenate([np.transpose(np.nan_to_num(uv), (2, 0, 1)), valid[None]], axis=0)
            lowres = torch.from_numpy(lowres.astype(np.float32))[None]
            feat_t, feat_l = model.encode_context(terrain, lowres)
            z = model.encode_background(feat_t, feat_l)
            out = [model.decode(feat_t, feat_l, lowres, p_all[i:i + args.chunk][None], plr_all[i:i + args.chunk][None], z)[0]
                   for i in range(0, len(points), args.chunk)]
            preds.append(torch.cat(out).numpy())
            print(f"frame {t}: mean |u,v| {np.hypot(preds[-1][:, 0], preds[-1][:, 1]).mean():.2f} m/s", flush=True)
    np.savez(args.out, pred=np.stack(preds).astype(np.float32))
    print("wrote", args.out)


if __name__ == "__main__":
    main()
