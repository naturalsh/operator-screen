# Jury demo walk-through

The whole demo on the live site (`665a137`, 17 Nov 2026), once on a 1920 × 1080 screen and once at phone size
(390 × 844). Every step went as expected; no console, page or network errors.

| Step | What happens | Desktop | Phone |
|---|---|---|---|
| 1 | The screen opens | [desktop](desktop_01_open.png) | [phone](phone_01_open.png) |
| 2 | **Demo**: 23 Jun 11:40, the Akçaalan call selected, paused at 1 min/s | [desktop](desktop_02_demo.png) | [phone](phone_02_demo.png) |
| 3 | **Take** (the call arrives reviewed by the call-taker: no urgency to confirm) | [desktop](desktop_03_take.png) | [phone](phone_03_take.png) |
| 4 | **Dispatch**: playback starts at 1 min/s with **Follow** on the crew | [desktop](desktop_04_dispatch_follow.png) | [phone](phone_04_dispatch_follow.png) |
| 5 | **Route cut**: the vehicle holds, a new route is offered | [desktop](desktop_05_route_cut.png) | [phone](phone_05_route_cut.png) |
| 6 | **Use new route**: the crew drives on | [desktop](desktop_06_new_route.png) | [phone](phone_06_new_route.png) |
| 7 | **Add fire**, a point inside the fire model's area | [desktop](desktop_07_add_point_box.png) | [phone](phone_07_add_point_box.png) |
| 8 | The forecast is recomputed in the browser with it | [desktop](desktop_08_after_point.png) | [phone](phone_08_after_point.png) |
| 9 | **Add fire**, a drawn area (4 corners) | [desktop](desktop_09_draw_area_box.png) | [phone](phone_09_draw_area_box.png) |
| 10 | The forecast: "+ 2 operator-confirmed fires", LIVE IN BROWSER | [desktop](desktop_10_after_area_forecast.png) | [phone](phone_10_after_area_forecast.png) |
| 11 | **Reassign** the crew to another call: notice, old call UNASSIGNED | [desktop](desktop_11_reassign.png) | [phone](phone_11_reassign.png) |
| 12 | **Decision log**: take, dispatch, re-route, fires, forecasts, reassign | [desktop](desktop_12_decision_log.png) | [phone](phone_12_decision_log.png) |

Tip for the live demo: at step 11 the first call in "Redirect to" cannot be reached from the crew at that moment
(every road to it is cut). Picking it shows "Not redirected: no road …" and changes nothing; pick the next one.
