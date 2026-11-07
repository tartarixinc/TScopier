-- Seed the internal alert recipients.
--
-- Staging already had these three addresses; production had none, so alert
-- events could fire and the evaluator would treat "no eligible recipients"
-- as delivered and send nothing. ON CONFLICT keeps this safe to re-run.

INSERT INTO public.alert_recipients (email, enabled, min_severity)
VALUES
  ('iloriemmanuel00@gmail.com', true, 'info'),
  ('martins.osodi@gmail.com', true, 'info'),
  ('nwankwojames7@gmail.com', true, 'info')
ON CONFLICT (email) DO NOTHING;
