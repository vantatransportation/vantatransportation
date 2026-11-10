-- Seed data. Run after the migrations.
-- IMPORTANT: all pricing below is DRAFT research supplied by the client. Nothing is
-- confirmed or published. Customers cannot receive quotes until an admin sets a
-- pricing config to "active".

insert into public.vehicle_tiers (name, slug, description, sort_order) values
  ('Business Class', 'business-class', 'Comfortable luxury vehicles for business and everyday travel.', 1),
  ('First Class', 'first-class', 'Premium vehicles and the full chauffeur experience.', 2);

insert into public.vehicle_categories (name, slug, description, capacity_label, image_url, sort_order) values
  ('Vans', 'vans', 'Group travel for larger parties, with room for everyone and their luggage.', '11–14 passengers', '/vehicles/van.svg', 1),
  ('Large SUVs', 'large-suvs', 'Space and comfort for families, small groups and business travel.', '6–7 passengers', '/vehicles/suv.svg', 2),
  ('Full-size Sedans', 'full-size-sedans', 'Our flagship sedans for executive and special-occasion travel.', '2–3 passengers', '/vehicles/sedan.svg', 3),
  ('Mid-size Sedans', 'mid-size-sedans', 'Refined everyday chauffeur travel for individuals and pairs.', '2–3 passengers', '/vehicles/sedan.svg', 4);

with c as (select id, slug from public.vehicle_categories), t as (select id, slug from public.vehicle_tiers)
insert into public.vehicles (category_id, tier_id, name, slug, similar_models, description, features, passenger_capacity, luggage_capacity, image_url, sort_order)
select (select id from c where c.slug = v.cat), (select id from t where t.slug = v.tier), v.name, v.slug, v.similar, v.descr, v.feats, v.pax, v.bags, v.img, v.ord
from (values
  ('vans','first-class','Mercedes-Benz Sprinter','mercedes-benz-sprinter','Similar models allowed','Premium van for larger groups.', array['Black exterior','Black leather interior'], 14, null::int, '/vehicles/van.svg', 1),
  ('vans','business-class','Ford Transit','ford-transit','Similar models allowed','Spacious van for larger groups.', array['Black exterior','Black leather interior'], 14, null, '/vehicles/van.svg', 2),
  ('large-suvs','business-class','Chevrolet Suburban','chevrolet-suburban','GMC Yukon XL, Ford Expedition or similar','Full-size SUV with generous space.', array['Black exterior','Black leather interior'], 8, null, '/vehicles/suv.svg', 3),
  ('large-suvs','first-class','Cadillac Escalade ESV','cadillac-escalade-esv','Lincoln Navigator L or similar','Luxury full-size SUV.', array['Black exterior','Black leather interior'], 8, null, '/vehicles/suv.svg', 4),
  ('full-size-sedans','first-class','Mercedes-Benz S-Class','mercedes-benz-s-class','BMW 7 Series or similar','Flagship executive sedan.', array['Black exterior','Black leather interior'], 4, null, '/vehicles/sedan.svg', 5),
  ('mid-size-sedans','business-class','Mercedes-Benz E-Class','mercedes-benz-e-class','BMW 5 Series or similar','Refined mid-size sedan.', array['Black exterior','Black leather interior'], 4, null, '/vehicles/sedan.svg', 6)
) as v(cat, tier, name, slug, similar, descr, feats, pax, bags, img, ord);

-- DRAFT pricing: second client reference table (per mile / hourly / minimum fare).
-- The client is still considering reductions (see notes), so these stay draft.
insert into public.pricing_configs (vehicle_id, status, label, notes, per_mile, hourly_rate, minimum_fare, hourly_included_miles, hourly_extra_mile_rate, min_hours)
select v.id, 'draft', 'DRAFT: client research, not confirmed', 'Client is considering $0.25–$0.50 less per mile and lower minimums/hourly rates. Extra-mile rate is a placeholder equal to the per-mile rate; confirm before activating.', p.per_mile, p.hourly, p.minimum, 20, p.per_mile, 2
from (values
  ('mercedes-benz-sprinter', 5.00, 125.00, 275.00),
  ('ford-transit', 4.50, 110.00, 225.00),
  ('chevrolet-suburban', 4.25, 95.00, 125.00),
  ('cadillac-escalade-esv', 5.00, 110.00, 150.00),
  ('mercedes-benz-s-class', 7.00, 150.00, 175.00),
  ('mercedes-benz-e-class', 5.00, 100.00, 100.00)
) as p(slug, per_mile, hourly, minimum)
join public.vehicles v on v.slug = p.slug;

insert into public.vehicle_standards (title, description, sort_order) values
  ('Black exterior', 'Every vehicle in our fleet is black on the outside.', 1),
  ('Black interior', 'A consistent, understated cabin in every vehicle.', 2),
  ('Leather seats', 'Leather seating throughout the fleet.', 3),
  ('Clean vehicles', 'Vehicles are cleaned and checked before every trip.', 4),
  ('Clean drivers', 'Drivers arrive presentable and professional.', 5);

insert into public.faqs (question, answer, sort_order) values
  ('How do I get a price?', 'Use Calculate Your Fare to enter your trip and see an estimate. You can then send us a booking request.', 1),
  ('Do I pay online?', 'By default the website takes booking requests and we confirm your booking with you directly. When online payment is turned on, you will see a Pay online option after you submit your request. A booking is not confirmed until we confirm it.', 2),
  ('Can I book by the hour?', 'Yes. Hourly bookings include a mileage allowance; additional miles are charged separately and shown in your quote.', 3),
  ('What if I do not like my quote?', 'Send us a query using Request a Better Quote. Requesting a better quote does not guarantee a lower price or discount. Each request is reviewed on a case-by-case basis, depending on trip details, distance, vehicle availability and other relevant circumstances.', 4),
  ('Can I add stops?', 'Yes. You can add multiple stops when you calculate your fare.', 5);

-- Placeholder website copy (flagged as placeholder in the dashboard).
insert into public.site_content (key, label, group_name, value, is_placeholder) values
  ('hero.title', 'Hero heading', 'Home', '"Chauffeured travel, handled properly."', true),
  ('hero.subtitle', 'Hero description', 'Home', '"Black-on-black vehicles, clean and professional drivers, and a fare you can see before you book."', true),
  ('hero.cta_primary', 'Hero primary button', 'Home', '"Calculate your fare"', true),
  ('hero.cta_secondary', 'Hero secondary button', 'Home', '"View our fleet"', true),
  ('about.title', 'About heading', 'About', '"Comfortable, reliable, discreet."', true),
  ('about.body', 'About text', 'About', '"Vanta Transportation provides chauffeur-driven travel with a focus on cleanliness, professionalism and comfort. This text is a placeholder: replace it with your own company story in the dashboard."', true),
  ('services', 'Rides we offer', 'Rides', '[{"title":"Point-to-point","description":"A chauffeur takes you directly from pickup to destination, with stops if you need them."},{"title":"Hourly chauffeur","description":"Keep a vehicle and driver for as long as you need, billed by the hour."},{"title":"Airport transfers","description":"Pickups and drop-offs for airport travel."},{"title":"Group travel","description":"Vans and large SUVs for bigger parties."}]', true),
  ('contact.email', 'Public email', 'Contact', '""', true),
  ('contact.phone', 'Public phone', 'Contact', '""', true),
  ('contact.address', 'Business address', 'Contact', '""', true),
  ('contact.hours', 'Hours', 'Contact', '""', true),
  ('footer.tagline', 'Footer tagline', 'Footer', '"Chauffeured transportation."', true);

-- Additional editable website copy (placeholders; edit under Website content).
insert into public.site_content (key, label, group_name, value, is_placeholder) values
  ('home.categories_title', 'Home: vehicle categories heading', 'Home', '"Choose the right vehicle"', true),
  ('home.categories_sub', 'Home: vehicle categories subheading', 'Home', '"From a single passenger to a group of fourteen."', true),
  ('home.fleet_title', 'Home: fleet heading', 'Home', '"The fleet"', true),
  ('home.fleet_note', 'Home: fleet footnote', 'Home', '"Similar models may be provided."', true),
  ('home.standards_title', 'Home: standards heading', 'Home', '"Every vehicle, every driver, the same standard"', true),
  ('home.why_title', 'Home: why choose us heading', 'Home', '"Why travel with Vanta"', true),
  ('home.cta_title', 'Home: closing call-to-action heading', 'Home', '"Ready to book your ride?"', true),
  ('pillars', 'Why choose us points', 'Home', '[{"title":"See the fare first","description":"Enter your trip and get an itemized estimate before you send a request."},{"title":"Room to negotiate","description":"If a quote does not suit your budget, tell us. We review every request personally."},{"title":"Fares by distance or by the hour","description":"Hourly bookings include a mileage allowance, and any extra miles are shown in your quote."}]', true),
  ('settings.notify_status_changes', 'Email customers on every booking status change', 'Settings', 'false', false)
on conflict (key) do nothing;
