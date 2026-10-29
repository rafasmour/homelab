---
case: food-log
kind: chat
profile: default
order: 10
toolsets: cli  # platform_toolsets.cli of the profile without kanban, clarify and talk
write_tools: true
needs: wger
setup: wgerTestDateAndToday
verify: wgerMealLogged
cleanup: wgerTestDate
params: {"time": "13:00", "tolerance_min": 15, "grams_min": 120, "grams_max": 180, "grams_expected": 150}
---
I ate a ham and cheese sandwich, about 150 g, for lunch on {{TEST_DATE}} at 13:00.
