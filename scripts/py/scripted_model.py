"""LLM の代わりに決まった順でツールを呼ぶ Strands モデル（測定用）。

Strands の Agent ループとプラグインのフック（before/after_tool_call, retry）は本物のまま動かし、
「モデルが何を言うか」だけを台本で固定する。AC-1 D3 で
「タイムアウト後にエージェントが同じ URL をもう一度取りに行く」を再現するのに使う。
台本で再現したことはログに planner="scripted" として必ず残す。
"""

from __future__ import annotations

import json
from typing import Any, AsyncGenerator, Dict, List, Optional

from strands.models.model import Model


class ScriptedModel(Model):
    def __init__(self, turns: List[Dict[str, Any]]):
        """turns: [{"tool": "http_request", "input": {...}}, ..., {"text": "..."}]"""
        self._turns = list(turns)
        self._i = 0
        self.seen_tool_results: List[str] = []

    def update_config(self, **model_config: Any) -> None:
        return None

    def get_config(self) -> Dict[str, Any]:
        return {"model_id": "scripted"}

    def structured_output(self, *args: Any, **kwargs: Any):  # type: ignore[override]
        raise NotImplementedError

    async def stream(  # type: ignore[override]
        self,
        messages: List[Dict[str, Any]],
        tool_specs: Optional[List[Dict[str, Any]]] = None,
        system_prompt: Optional[str] = None,
        **kwargs: Any,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        # 直前のツール結果を記録しておく（台本が何を見て次の手を打ったかの証跡）
        if messages:
            for block in messages[-1].get("content", []):
                tr = block.get("toolResult")
                if tr:
                    texts = [c.get("text", "") for c in tr.get("content", []) if isinstance(c, dict)]
                    self.seen_tool_results.append(" ".join(texts)[:300])

        turn = self._turns[self._i] if self._i < len(self._turns) else {"text": "done"}
        self._i += 1
        yield {"messageStart": {"role": "assistant"}}
        if "tool" in turn:
            tool_use_id = f"scripted-{self._i}"
            yield {"contentBlockStart": {"start": {"toolUse": {"toolUseId": tool_use_id, "name": turn["tool"]}}}}
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(turn["input"])}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockDelta": {"delta": {"text": turn["text"]}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}
