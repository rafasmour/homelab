---
case: research-qa
kind: chat
profile: ai-news
order: 14
toolsets: cli
write_tools: false
research: true
verify: shortAnswer
params: {"must_mention": [{"pattern": "router", "label": "router"}, {"pattern": "\\b(several|multiple|many|more than one|different|other)\\b[^.]{0,40}\\bmodels\\b|\\bmodels\\b[^.]{0,60}\\b(on demand|dynamically|at runtime|per request)\\b", "label": "serving several models"}, {"pattern": "\\b(load|loads|loading|unload|switch|switches|swap|swaps|route|routes|routing)\\b", "label": "loading or routing models on request"}], "max_sentences": 3, "asked": "two", "max_chars": 800, "asked_chars": "two short sentences", "must_not": [{"pattern": "\\b(couldn'?t|could not|unable to|did not|didn'?t) find\\b|\\bno (such|specific|dedicated) (feature|mode)\\b|\\bnot (a|an) (official|existing|documented|real)\\b|\\b(does ?n[o']t|doesn'?t) (exist|have)\\b", "label": "says it found nothing / the feature does not exist"}]}
---
In two short sentences, what is llama.cpp router mode?
