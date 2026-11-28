# Farmer monitoring: in-range matches

The Analyze action compares the current fresh sensor snapshot with the active fish profiles. The profile API supplies the admin-configured species ranges when available; the app retains its existing built-in fallback profiles. Species without a usable range for a measured parameter are not scored.

**In-range match (%) = round(100 x number of measured values inside the species ranges / number of valid measured values).** Both range endpoints count as inside. Example: three matches out of four measurements is 75%; two out of two is 100% with incomplete coverage. The percentage is neither a calibrated probability nor a stocking or survival recommendation.

The ordering and normalized distance tie-break use the existing partial ranking. Species with equal match counts and equal distance (within numerical tolerance) have the same displayed rank. The ranking never converts missing or invalid values to zero, and estimated turbidity is not a match input. Missing parameters are listed next to the coverage count. A confirmed Critical status from an existing operational rule blocks the ranking; a pending turbidity proposal cannot do so.

The four dashboard monitoring parameters and the existing Manual Analysis workflow are separate. The Admin UI no longer edits ammonia; existing stored ammonia thresholds and the backend rules that use them are unchanged.

The combined history plot uses independent scales when different units share the plot. The details show actual values and units. The period controls filter the existing API history feed (up to 60 recent samples); they do not retrieve a full archive. Existing time and sensor-validity checks still exclude unverified timestamps and uncalibrated turbidity, and break traces at missing values, outages, and assignment changes.

The scoring arithmetic and state handling are tested in `src/lib/sensorSuitability.test.ts` and the dashboard browser test. This validates software behavior, not the biological validity of the underlying species ranges or sensors.
