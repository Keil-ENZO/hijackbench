# Third-party notices

hijackbench is released under the MIT license, see `LICENSE`. It reuses the material below.

## AgentDojo

- Source: https://github.com/ethz-spylab/agentdojo, commit `089ed468cf3e`
- Paper: Debenedetti et al., "AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defenses for LLM Agents", NeurIPS 2024, https://arxiv.org/abs/2406.13352
- What is reused: the attack templates of `src/agentdojo/attacks/baseline_attacks.py` and `src/agentdojo/attacks/important_instructions_attacks.py`, copied word for word in `packages/core/src/attacks/catalog.ts`: `direct`, `ignore_previous`, `injecagent`, `important_instructions` and `tool_knowledge`. The order of the hijack cases comes from `src/agentdojo/attacks/dos_attacks.py`.
- The `injecagent` template comes from Zhan et al., "InjecAgent: Benchmarking Indirect Prompt Injections in Tool-Integrated Large Language Model Agents", https://arxiv.org/abs/2403.02691, as shipped in AgentDojo.
- License: MIT, reproduced below.

```
MIT License

Copyright (c) 2024 Edoardo Debenedetti, Jie Zhang, Mislav Balunovic, Luca Beurer-Kellner, Marc Fischer, and Florian Tramèr

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## OWASP Top 10 for LLM Applications

The catalog labels its cases with the category `LLM01:2025 Prompt Injection` of the OWASP Top 10 for LLM Applications, https://genai.owasp.org/llmrisk/llm01-prompt-injection/. Only the name of the category is used. No text of the document is copied.
