(function () {
  const STORAGE_KEY = 'sid-employer-radar-state-v2';
  const DAY_MS = 24 * 60 * 60 * 1000;
  const SOURCE_PLATFORMS = ['Seek', 'Indeed', 'CareerOne', 'Jora'];

  function todayIso() {
    return new Date().toISOString();
  }

  function stableId(prefix, value) {
    let hash = 0;
    const text = String(value);
    for (let i = 0; i < text.length; i += 1) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return `${prefix}_${Math.abs(hash).toString(36)}`;
  }

  function cleanText(value) {
    return String(value || '').toLowerCase();
  }

  function normalizeName(name) {
    return cleanText(name)
      .replace(/\bpty\b|\bltd\b|\blimited\b|\baustralia\b|\bgroup\b|\bholdings\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function rowValue(row, keys) {
    for (const key of keys) {
      if (row[key] != null && String(row[key]).trim() !== '') return row[key];
    }
    return '';
  }

  function matchTerms(text, terms) {
    const haystack = cleanText(text);
    return (terms || []).filter((term) => haystack.includes(cleanText(term)));
  }

  function textIncludesAny(text, terms) {
    return matchTerms(text, terms).length > 0;
  }

  function getJobText(job) {
    return [job.title, job.description_text, job.raw_snippet, job.location_text, job.salary_text].filter(Boolean).join(' ');
  }

  function findOccupation(job, rules) {
    const text = getJobText(job);
    const title = cleanText(job.title);
    let best = null;

    for (const occupation of rules.occupations) {
      const terms = [occupation.title, ...(occupation.common_titles || []), ...(occupation.chinese_titles || [])];
      const matched = matchTerms(`${job.title || ''} ${job.description_text || ''}`, terms);
      if (!matched.length) continue;

      const titleHit = terms.some((term) => title.includes(cleanText(term)));
      const score = titleHit ? 90 : 74;
      const specificity = matched.join(' ').length;
      if (!best || score > best.score || (score === best.score && specificity > best.specificity)) {
        best = { score, specificity, occupation, evidence: matched.slice(0, 4) };
      }
    }

    if (!best && textIncludesAny(text, rules.industryHints || [])) {
      return { score: 42, occupation: null, evidence: matchTerms(text, rules.industryHints).slice(0, 3) };
    }

    return best || { score: 10, occupation: null, evidence: [] };
  }

  function scoreLanguage(job, employer, rules) {
    const text = `${getJobText(job)} ${employer.website || ''} ${(employer.trading_names || []).join(' ')}`;
    const strong = matchTerms(text, rules.language.strong);
    if (strong.length) return { score: 92, evidence: strong.slice(0, 4), tier: 'strong' };

    const medium = matchTerms(text, rules.language.medium);
    if (medium.length) return { score: 62, evidence: medium.slice(0, 4), tier: 'medium' };

    const weak = matchTerms(text, rules.language.weak);
    if (weak.length) return { score: 34, evidence: weak.slice(0, 4), tier: 'weak' };

    return { score: 0, evidence: [], tier: 'none' };
  }

  function scoreSponsorship(job, employer, rules) {
    const text = getJobText(job);
    const negative = matchTerms(text, rules.sponsorship.negative);
    const positive = matchTerms(text, rules.sponsorship.positive);
    const seedSponsor = employer.sponsor_seed === true || employer.sponsor_status === 'matched';

    if (negative.length) {
      return { score: 0, level: 'S-1', negative: true, evidence: negative.slice(0, 4) };
    }

    if (seedSponsor && positive.length) {
      return { score: 96, level: 'S4', negative: false, evidence: ['sponsor seed matched', ...positive].slice(0, 5) };
    }

    if (seedSponsor) {
      return { score: 78, level: 'S3', negative: false, evidence: ['sponsor seed matched'] };
    }

    if (positive.length) {
      return { score: 70, level: 'S2', negative: false, evidence: positive.slice(0, 4) };
    }

    return { score: 18, level: 'S1', negative: false, evidence: [] };
  }

  function scoreRegion(location, rules) {
    if (!location) return { score: 20, tier: 'Unknown', evidence: [] };

    const postcode = Number(location.postcode);
    const suburb = cleanText(location.suburb);
    const lga = cleanText(location.lga);
    const hot = rules.regions.hot_areas.find((area) => (
      cleanText(area.suburb) === suburb || cleanText(area.lga) === lga || Number(area.postcode) === postcode
    ));

    if (hot) {
      return {
        score: 18,
        tier: 'P4',
        evidence: [`hot area: ${hot.reason}`],
        hotArea: true,
        hotPenalty: Number(hot.priority_penalty || 25)
      };
    }

    const tiers = rules.regions.priority_tiers;
    if ((tiers.P1 || []).some((item) => cleanText(item) === suburb || cleanText(item) === lga || Number(item) === postcode)) {
      return { score: 96, tier: 'P1', evidence: ['priority regional match'], hotArea: false, hotPenalty: 0 };
    }
    if ((tiers.P2 || []).some((item) => cleanText(item) === suburb || cleanText(item) === lga || Number(item) === postcode)) {
      return { score: 82, tier: 'P2', evidence: ['regional city match'], hotArea: false, hotPenalty: 0 };
    }
    if ((tiers.P3 || []).some((item) => cleanText(item) === suburb || cleanText(item) === lga || Number(item) === postcode)) {
      return { score: 56, tier: 'P3', evidence: ['fringe match'], hotArea: false, hotPenalty: 0 };
    }
    if (location.regional_category && cleanText(location.regional_category).includes('regional')) {
      return { score: 72, tier: 'Regional', evidence: [location.regional_category], hotArea: false, hotPenalty: 0 };
    }
    return { score: 36, tier: 'Unranked', evidence: [], hotArea: false, hotPenalty: 0 };
  }

  function scoreContact(employer, contacts) {
    const employerContacts = contacts.filter((contact) => contact.employer_id === employer.employer_id && !contact.do_not_contact);
    if (!employerContacts.length) return { score: 0, evidence: [] };

    const ordered = employerContacts.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
    const best = ordered[0];
    const typeScore = {
      careers_email: 96,
      apply_url: 92,
      contact_form: 84,
      generic_email: 72,
      phone: 64,
      website: 48
    };

    return {
      score: Math.max(typeScore[best.contact_type] || 35, Number(best.confidence || 0)),
      evidence: ordered.slice(0, 3).map((contact) => `${contact.contact_type}: ${contact.value}`)
    };
  }

  function scoreFreshness(job, now = new Date()) {
    if (!job.seen_date && !job.posted_date) return 20;
    const date = new Date(job.posted_date || job.seen_date);
    if (Number.isNaN(date.getTime())) return 20;
    const age = Math.max(0, Math.floor((now.getTime() - date.getTime()) / DAY_MS));
    if (age <= 3) return 100;
    if (age <= 7) return 86;
    if (age <= 14) return 72;
    if (age <= 30) return 54;
    return 28;
  }

  function bucketForScore(score, sponsorshipLevel, negative) {
    if (negative) return 'D';
    if (score >= 88 && ['S4', 'S3', 'S2'].includes(sponsorshipLevel)) return 'A';
    if (score >= 72) return 'B';
    if (score >= 55) return 'C';
    return 'D';
  }

  function platformSearchUrl(platform, title, region) {
    const q = encodeURIComponent(title || '482 sponsorship');
    const l = encodeURIComponent(region || 'Australia');
    if (platform === 'Seek') return `https://www.seek.com.au/${q}-jobs/in-${l}`;
    if (platform === 'Indeed') return `https://au.indeed.com/jobs?q=${q}&l=${l}`;
    if (platform === 'CareerOne') return `https://www.careerone.com.au/jobs?keywords=${q}&location=${l}`;
    return `https://au.jora.com/jobs?q=${q}&l=${l}`;
  }

  function regionPlaces(region) {
    const text = cleanText(region || 'NSW');
    if (text.includes('vic') || text.includes('melbourne') || text.includes('shepparton') || text.includes('mildura')) {
      return [
        ['Shepparton', '3630', 'VIC', 'Greater Shepparton', 'Hume'],
        ['Mildura', '3500', 'VIC', 'Mildura', 'Loddon Mallee'],
        ['Ballarat', '3350', 'VIC', 'Ballarat', 'Grampians'],
        ['Bendigo', '3550', 'VIC', 'Greater Bendigo', 'Loddon Mallee'],
        ['Traralgon', '3844', 'VIC', 'Latrobe', 'Gippsland'],
        ['Warrnambool', '3280', 'VIC', 'Warrnambool', 'Barwon South West']
      ];
    }
    if (text.includes('qld') || text.includes('queensland')) {
      return [
        ['Toowoomba', '4350', 'QLD', 'Toowoomba', 'Darling Downs'],
        ['Cairns', '4870', 'QLD', 'Cairns', 'Far North Queensland'],
        ['Townsville', '4810', 'QLD', 'Townsville', 'North Queensland'],
        ['Bundaberg', '4670', 'QLD', 'Bundaberg', 'Wide Bay'],
        ['Rockhampton', '4700', 'QLD', 'Rockhampton', 'Central Queensland'],
        ['Mackay', '4740', 'QLD', 'Mackay', 'Mackay Region']
      ];
    }
    return [
      ['West Gosford', '2250', 'NSW', 'Central Coast', 'Central Coast'],
      ['Thurgoona', '2640', 'NSW', 'Albury', 'Riverina Murray'],
      ['Griffith', '2680', 'NSW', 'Griffith', 'Riverina'],
      ['Temora', '2666', 'NSW', 'Temora', 'Riverina'],
      ['Forster', '2428', 'NSW', 'Mid-Coast', 'Mid North Coast'],
      ['Toronto', '2283', 'NSW', 'Lake Macquarie', 'Hunter'],
      ['Penrith', '2750', 'NSW', 'Penrith', 'Western Sydney'],
      ['Alexandria', '2015', 'NSW', 'Sydney', 'Sydney Metro']
    ];
  }

  const CANDIDATE_TEMPLATES = [
    ['Chocolate & nougat factory', 'Mechanical Fitter General Maintenance Supervisor', '323211', 'Mechanical Fitter', '02 4322 3222', '', '确认提供482签证；必须确认是否全职与薪资达标。'],
    ['AMA Collision', 'Panel Beater (钣金工)', '324111', 'Panel Beater', '(02) 6049 3000', '', '境内人士优先；需确认是否愿意提名。'],
    ['NSW Health', 'Registered Nurse - Theatre', '254423', 'Registered Nurse', '', 'Kristy Wilson via careers portal', '注册护士；确认是否接受482/SID。'],
    ['NSW Health', 'Registered Nurse', '254499', 'Registered Nurse', '', 'Wendy Skidmore via careers portal', '福利院/医院岗位；确认 sponsor pathway。'],
    ['Great Care Services', 'Registered Nurse', '254499', 'Registered Nurse', '', 'info@greatcareservice.example', '确认护理资质与偏远地区需求。'],
    ['Toronthai Thai Restaurant', 'Full-Time Chef / Cook Wanted', '351311', 'Chef', '', 'toronthai@example.com', '6个月以后确认低签证担保风险；需复核广告。'],
    ['SQ BAR AND GRILL PENRITH', 'Tandoori Chef and Indian curry chef', '351311', 'Chef', '', 'uppalpreet625@example.com', '厨师岗位；确认工作地点与担保意愿。'],
    ['Tesla', 'Vehicle Service Technician', '321211', 'Motor Mechanic', '', '', '可支持WHV后期转482；需确认招聘广告原文。'],
    ['Riverina Aged Care', 'Aged Care Registered Nurse', '254499', 'Registered Nurse', '02 6900 1133', 'careers@riverinacare.example', 'Regional aged care; Mandarin useful for residents.'],
    ['Murray Auto Works', 'Diesel Motor Mechanic', '321212', 'Diesel Motor Mechanic', '02 6021 0040', 'jobs@murrayauto.example', '重型车维修；确认482 sponsor历史。'],
    ['Coastal Early Learning', 'Early Childhood Teacher', '241111', 'Early Childhood Teacher', '02 6555 3321', 'director@coastalelc.example', '幼教紧缺；确认ACEQA与full-time。'],
    ['Hunter Kitchen Group', 'Chef de Partie', '351311', 'Chef', '02 4900 2088', 'hr@hunterkitchen.example', '餐饮岗位；排除no sponsorship否定词。'],
    ['Regional Panel & Paint', 'Panel Beater', '324111', 'Panel Beater', '02 6955 1002', 'admin@regionalpaint.example', '技工岗位；确认ANZSCO与薪资。'],
    ['Central Coast Dental Lab', 'Dental Technician', '411213', 'Dental Technician', '02 4300 1188', 'lab@ccdental.example', '技术岗位；需复核CSOL状态。'],
    ['Golden Wok Regional', 'Cook', '351411', 'Cook', '02 6577 9012', 'goldenwok.jobs@example.com', '中餐馆弱中文信号；需确认担保。'],
    ['Blue Gum Childcare', 'Child Care Centre Manager', '134111', 'Child Care Centre Manager', '02 6862 8080', 'manager@bluegumchildcare.example', '管理岗位；确认centre规模与提名条件。'],
    ['Northwest Truck Repairs', 'Motor Mechanic', '321211', 'Motor Mechanic', '02 6766 4400', 'service@nwtruck.example', '汽修岗位；确认482 nomination。'],
    ['Lakeside Care', 'Personal Care Assistant', '423111', 'Aged or Disabled Carer', '02 4933 8181', 'jobs@lakesidecare.example', '护理岗位；需确认职业是否适配客户条件。'],
    ['Pacific Accounting Group', 'Accountant', '221111', 'Accountant', '02 8000 7732', 'careers@pacificaccounting.example', '会计岗位竞争较高；确认担保迹象。'],
    ['Regional Hospitality Co', 'Restaurant Manager', '141111', 'Cafe or Restaurant Manager', '02 6382 5050', 'people@regionalhospitality.example', '餐厅经理；确认full-time与市场薪资。'],
    ['Country Medical Centre', 'Registered Nurse', '254499', 'Registered Nurse', '02 6341 9088', 'recruitment@countrymedical.example', '医疗岗位；优先联系HR。'],
    ['Harbour Smash Repairs', 'Vehicle Painter', '324311', 'Vehicle Painter', '02 6651 2208', 'info@harboursmash.example', '喷漆技工；确认是否在CSOL。'],
    ['Mandarin Community Care', 'Bilingual Support Worker', '423111', 'Aged or Disabled Carer', '02 4721 3110', 'hr@mandarincare.example', '中文强信号；确认是否有sponsorship。'],
    ['Regional Food Factory', 'Production Manager', '133512', 'Production Manager', '02 6921 7788', 'jobs@regionalfood.example', '食品工厂；确认岗位是否符合CSOL。']
  ];

  function createPlatformCandidates(state, region, sources) {
    const now = todayIso();
    const places = regionPlaces(region);
    const activeSources = (sources && sources.length ? sources : SOURCE_PLATFORMS).filter((source) => SOURCE_PLATFORMS.includes(source));
    let created = 0;

    CANDIDATE_TEMPLATES.slice(0, 24).forEach((template, index) => {
      const [company, title, anzsco, occupation, phone, email, notes] = template;
      const place = places[index % places.length];
      const source = activeSources[index % activeSources.length] || 'Indeed';
      const employerId = stableId('emp', `${company}-${place[0]}-${source}`);
      const jobId = stableId('job', `${company}-${title}-${place[0]}-${source}`);
      const contactId = stableId('con', `${company}-${phone}-${email}`);

      if (!state.employers.some((item) => item.employer_id === employerId)) {
        state.employers.push({
          employer_id: employerId,
          abn: '',
          acn: '',
          legal_name: company,
          trading_names: [],
          normalized_name: normalizeName(company),
          entity_status: '待复核',
          gst_status: '待复核',
          company_type: '',
          registration_date: '',
          website: '',
          main_phone: phone,
          main_email: email,
          contact_url: '',
          sponsor_seed: true,
          sponsor_status: 'matched',
          source_first_seen: now,
          source_last_checked: now
        });
      }

      if (!state.employer_locations.some((item) => item.employer_id === employerId)) {
        state.employer_locations.push({
          location_id: stableId('loc', `${employerId}-${place[1]}`),
          employer_id: employerId,
          address_raw: `${place[0]} ${place[2]} ${place[1]}`,
          suburb: place[0],
          postcode: place[1],
          state: place[2],
          lat: 0,
          lng: 0,
          lga: place[3],
          rdv_region: place[4],
          regional_category: 'Regional or target area'
        });
      }

      if (!state.job_ads.some((item) => item.job_id === jobId)) {
        const sourceUrl = platformSearchUrl(source, title, `${place[0]} ${place[2]}`);
        state.job_ads.push({
          job_id: jobId,
          source_name: source,
          source_url: sourceUrl,
          source_type: 'platform_review',
          employer_id: employerId,
          title,
          description_text: `${title}. 482/SID suitability review task. Chinese/Mandarin signal and sponsorship evidence must be confirmed from the platform advert manually or through authorized data access.`,
          location_text: `${place[0]} ${place[2]}`,
          postcode: place[1],
          salary_text: '待复核',
          posted_date: now,
          seen_date: now,
          raw_snippet: notes,
          evidence_hash: stableId('ev', jobId),
          anzsco_code: anzsco,
          progress: '未联系',
          notes,
          ad_screenshot: ''
        });
        created += 1;
      }

      if ((phone || email) && !state.contacts.some((item) => item.contact_id === contactId)) {
        state.contacts.push({
          contact_id: contactId,
          employer_id: employerId,
          contact_type: email ? 'generic_email' : 'phone',
          value: email || phone,
          role: '招聘/公司公开联系方式',
          source_url: '',
          source_context: source,
          confidence: email ? 72 : 64,
          is_generic_contact: true,
          is_personal_contact: false,
          do_not_contact: false,
          last_verified: now,
          phone,
          email
        });
      }
    });

    state.meta.search_region = region || 'NSW';
    state.meta.search_sources = activeSources;
    return created;
  }

  function scoreLead(job, employer, location, contacts, rules, now = new Date()) {
    const language = scoreLanguage(job, employer, rules);
    const sponsorship = scoreSponsorship(job, employer, rules);
    const occupation = findOccupation(job, rules);
    const region = scoreRegion(location, rules);
    const contact = scoreContact(employer, contacts);
    const freshness = scoreFreshness(job, now);

    let finalScore = (
      0.30 * sponsorship.score +
      0.20 * language.score +
      0.20 * occupation.score +
      0.15 * region.score +
      0.10 * contact.score +
      0.05 * freshness
    );

    if (region.hotPenalty) finalScore -= region.hotPenalty;
    if (sponsorship.negative) finalScore -= 40;
    finalScore = Math.max(0, Math.min(100, Math.round(finalScore)));

    return {
      lead_id: `lead_${job.job_id}`,
      employer_id: employer.employer_id,
      latest_job_id: job.job_id,
      region_score: Math.round(region.score),
      language_score: Math.round(language.score),
      sponsorship_score: Math.round(sponsorship.score),
      occupation_score: Math.round(occupation.score),
      contact_score: Math.round(contact.score),
      freshness_score: Math.round(freshness),
      final_score: finalScore,
      priority_bucket: bucketForScore(finalScore, sponsorship.level, sponsorship.negative),
      sponsorship_level: sponsorship.level,
      negative_sponsorship_flag: sponsorship.negative,
      priority_region_tier: region.tier,
      is_hot_area: Boolean(region.hotArea),
      occupation_match: occupation.occupation ? {
        anzsco_code: occupation.occupation.anzsco_code,
        title: occupation.occupation.title,
        csol_flag: occupation.occupation.csol_flag
      } : null,
      evidence: {
        language: language.evidence,
        sponsorship: sponsorship.evidence,
        occupation: occupation.evidence,
        region: region.evidence,
        contact: contact.evidence
      },
      review_status: 'new',
      next_action: sponsorship.negative ? 'discard' : finalScore >= 72 ? 'contact' : 'manual_review',
      scored_at: now.toISOString()
    };
  }

  function scoreState(state, now = new Date()) {
    const contacts = state.contacts || [];
    const locations = state.employer_locations || [];
    const employers = state.employers || [];
    const leadsById = new Map((state.lead_scores || []).map((lead) => [lead.lead_id, lead]));

    const leadScores = (state.job_ads || []).map((job) => {
      const employer = employers.find((item) => item.employer_id === job.employer_id);
      if (!employer) return null;
      const location = locations.find((item) => item.employer_id === employer.employer_id);
      const next = scoreLead(job, employer, location, contacts, state.rules, now);
      const existing = leadsById.get(next.lead_id);
      return {
        ...next,
        review_status: existing?.review_status || next.review_status,
        reviewer_notes: existing?.reviewer_notes || '',
        next_action: existing?.next_action || next.next_action,
        last_contacted: existing?.last_contacted || null
      };
    }).filter(Boolean);

    return {
      ...state,
      lead_scores: leadScores.sort((a, b) => b.final_score - a.final_score),
      meta: { ...state.meta, last_scored_at: now.toISOString() }
    };
  }

  function createInitialState() {
    const now = todayIso();
    const state = {
      meta: {
        app_name: '482/SID Employer Radar',
        version: '0.2.0-pages',
        created_at: now,
        updated_at: now,
        last_scored_at: null,
        last_daily_run_at: null,
        search_region: 'NSW',
        search_sources: SOURCE_PLATFORMS
      },
      rules: {
        language: {
          strong: ['Mandarin required', 'Cantonese required', 'Chinese speaking', 'Chinese speaker', 'Fluent in Mandarin', 'Bilingual English and Chinese', '普通话', '粤语', '中文', '会中文'],
          medium: ['Chinese clients', 'Chinese community', 'bilingual Chinese', 'Mandarin preferred', 'Cantonese preferred'],
          weak: ['Chinese restaurant', 'Asian grocery', 'Chinese school', 'migration service', 'Chinese accounting']
        },
        sponsorship: {
          positive: ['482', 'subclass 482', 'Skills in Demand', 'SID visa', 'TSS', 'Temporary Skill Shortage', 'visa sponsorship', 'sponsorship available', 'employer sponsored', 'nomination', 'approved sponsor', 'labour agreement', 'DAMA', 'relocation support'],
          negative: ['no sponsorship', 'sponsorship is not available', 'must have full working rights', 'Australian citizen or permanent resident only', 'PR or citizen only', 'unrestricted work rights']
        },
        occupations: [
          { anzsco_code: '351311', title: 'Chef', csol_flag: true, common_titles: ['chef', 'sous chef', 'head chef'], chinese_titles: ['厨师'] },
          { anzsco_code: '351411', title: 'Cook', csol_flag: true, common_titles: ['cook', 'line cook'], chinese_titles: ['帮厨'] },
          { anzsco_code: '321212', title: 'Diesel Motor Mechanic', csol_flag: true, common_titles: ['diesel mechanic', 'diesel motor mechanic'], chinese_titles: ['柴油技工'] },
          { anzsco_code: '321211', title: 'Motor Mechanic', csol_flag: true, common_titles: ['motor mechanic', 'automotive mechanic', 'light vehicle mechanic'], chinese_titles: ['汽车维修'] },
          { anzsco_code: '241111', title: 'Early Childhood Teacher', csol_flag: true, common_titles: ['early childhood teacher', 'ect'], chinese_titles: ['幼教'] },
          { anzsco_code: '134111', title: 'Child Care Centre Manager', csol_flag: true, common_titles: ['childcare centre manager', 'child care centre manager'], chinese_titles: ['托儿中心经理'] },
          { anzsco_code: '423111', title: 'Aged or Disabled Carer', csol_flag: true, common_titles: ['aged care worker', 'aged or disabled carer', 'personal care assistant', 'pca'], chinese_titles: ['养老护理', '护理员'] },
          { anzsco_code: '254499', title: 'Registered Nurse', csol_flag: true, common_titles: ['registered nurse', 'rn', 'aged care nurse'], chinese_titles: ['注册护士'] },
          { anzsco_code: '221111', title: 'Accountant', csol_flag: true, common_titles: ['accountant', 'tax accountant'], chinese_titles: ['会计'] },
          { anzsco_code: '261111', title: 'ICT Business Analyst', csol_flag: true, common_titles: ['ict business analyst', 'business analyst'], chinese_titles: ['业务分析师'] },
          { anzsco_code: '261313', title: 'Software Engineer', csol_flag: true, common_titles: ['software engineer', 'developer', 'full stack engineer'], chinese_titles: ['软件工程师'] },
          { anzsco_code: '225113', title: 'Marketing Specialist', csol_flag: true, common_titles: ['marketing specialist', 'digital marketing specialist'], chinese_titles: ['市场专员'] },
          { anzsco_code: '141111', title: 'Cafe or Restaurant Manager', csol_flag: true, common_titles: ['restaurant manager', 'cafe manager', 'venue manager'], chinese_titles: ['餐厅经理'] }
        ],
        industryHints: ['aged care', 'childcare', 'automotive', 'restaurant', 'accounting', 'ict', 'marketing'],
        regions: {
          priority_tiers: {
            P1: ['Mildura', 'Warrnambool', 'Shepparton', 'Horsham', 'Swan Hill', 'Bairnsdale', 'Sale', 'Traralgon', 'Wodonga'],
            P2: ['Ballarat', 'Geelong', 'Bendigo', 'Wangaratta'],
            P3: ['Yarra Ranges', 'Cardinia', 'Mornington Peninsula']
          },
          hot_areas: [
            { suburb: 'Melbourne', postcode: '3000', lga: 'Melbourne', reason: 'CBD high competition', priority_penalty: 30 },
            { suburb: 'Box Hill', postcode: '3128', lga: 'Whitehorse', reason: 'popular Chinese market', priority_penalty: 25 },
            { suburb: 'Glen Waverley', postcode: '3150', lga: 'Monash', reason: 'popular Chinese market', priority_penalty: 25 },
            { suburb: 'Clayton', postcode: '3168', lga: 'Monash', reason: 'popular Chinese market', priority_penalty: 22 },
            { suburb: 'Springvale', postcode: '3171', lga: 'Greater Dandenong', reason: 'popular Chinese market', priority_penalty: 20 }
          ]
        }
      },
      source_policies: [
        { source_name: 'Seek', allowed_method: 'job_alert_or_manual_review', tos_status: 'restricted', can_store_content: false, can_use_for_outreach: false, notes: '不做自动爬取；只生成复核入口或处理你授权/收到的数据。' },
        { source_name: 'Indeed', allowed_method: 'job_alert_manual_or_authorized_access', tos_status: 'review_required', can_store_content: 'source_dependent', can_use_for_outreach: false, notes: '先用提醒邮件/授权数据/人工复核。' },
        { source_name: 'CareerOne', allowed_method: 'manual_review_or_authorized_access', tos_status: 'review_required', can_store_content: 'source_dependent', can_use_for_outreach: false, notes: '先生成搜索复核入口。' },
        { source_name: 'Jora', allowed_method: 'manual_review_or_authorized_access', tos_status: 'review_required', can_store_content: 'source_dependent', can_use_for_outreach: false, notes: '先生成搜索复核入口。' }
      ],
      employers: [],
      employer_locations: [],
      job_ads: [],
      contacts: [],
      lead_scores: [],
      activity: [{ activity_id: stableId('act', now), timestamp: now, type: 'system', message: '工作区已初始化。输入地区后点击运行今日雷达。' }]
    };
    return scoreState(state);
  }

  function saveState(state) {
    const next = { ...state, meta: { ...state.meta, updated_at: todayIso() } };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }

  function readState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed.meta || parsed.meta.version !== '0.2.0-pages') return saveState(createInitialState());
        return parsed;
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    return saveState(createInitialState());
  }

  function addActivity(state, type, message) {
    const timestamp = todayIso();
    state.activity = [
      { activity_id: stableId('act', `${timestamp}-${message}`), timestamp, type, message },
      ...(state.activity || [])
    ].slice(0, 80);
  }

  function upsertEmployer(state, row) {
    const rawName = rowValue(row, ['公司名称', 'raw_company_name', 'company', 'company_name', 'name', 'legal_name']);
    if (!rawName.trim()) return null;

    const abn = String(rowValue(row, ['abn', 'ABN'])).trim();
    const normalized = normalizeName(rawName);
    const key = abn || normalized;
    const employerId = stableId('emp', key);
    const existing = state.employers.find((item) => item.employer_id === employerId || (abn && item.abn === abn));
    const sponsorSeed = row.sponsor_seed === true || String(row.sponsor_seed || '').toLowerCase() === 'true' || String(rowValue(row, ['source', '备注'])).toLowerCase().includes('482');
    const employer = {
      employer_id: existing?.employer_id || employerId,
      abn: abn || existing?.abn || '',
      acn: row.acn || existing?.acn || '',
      legal_name: rawName.trim(),
      trading_names: existing?.trading_names || [],
      normalized_name: normalized,
      entity_status: existing?.entity_status || 'Unknown',
      gst_status: existing?.gst_status || 'Unknown',
      company_type: existing?.company_type || '',
      registration_date: existing?.registration_date || '',
      website: row.website || existing?.website || '',
      main_phone: rowValue(row, ['联系方式', 'phone']) || existing?.main_phone || '',
      main_email: rowValue(row, ['邮箱', 'email']) || existing?.main_email || '',
      contact_url: row.contact_url || existing?.contact_url || '',
      sponsor_seed: existing?.sponsor_seed || sponsorSeed,
      sponsor_status: existing?.sponsor_status || (sponsorSeed ? 'matched' : 'unknown'),
      known_occupation: rowValue(row, ['招聘岗位（已确认符合CSOL清单要求）', '招聘岗位', 'occupation', 'known_occupation']) || existing?.known_occupation || '',
      source_first_seen: existing?.source_first_seen || todayIso(),
      source_last_checked: todayIso()
    };

    if (existing) Object.assign(existing, employer);
    else state.employers.push(employer);

    const address = rowValue(row, ['公司地址', 'address']);
    const region = rowValue(row, ['所在地区', 'state']);
    const postcode = row.postcode || row.Postcode || String(address).match(/\b\d{4}\b/)?.[0] || '';
    const suburb = row.suburb || row.Suburb || String(address).replace(/\b(NSW|VIC|QLD|SA|WA|TAS|ACT|NT)\b|\b\d{4}\b/gi, '').trim();
    if (postcode || suburb) {
      const existingLocation = state.employer_locations.find((item) => item.employer_id === employer.employer_id);
      const location = {
        location_id: existingLocation?.location_id || stableId('loc', `${employer.employer_id}-${postcode}-${suburb}`),
        employer_id: employer.employer_id,
      address_raw: address || [suburb, region || 'NSW', postcode].filter(Boolean).join(' '),
      suburb,
      postcode,
      state: region || 'NSW',
        lat: Number(row.lat || existingLocation?.lat || 0),
        lng: Number(row.lng || existingLocation?.lng || 0),
        lga: row.lga || existingLocation?.lga || '',
        rdv_region: row.rdv_region || existingLocation?.rdv_region || '',
        regional_category: row.regional_category || existingLocation?.regional_category || ''
      };
      if (existingLocation) Object.assign(existingLocation, location);
      else state.employer_locations.push(location);
    }

    const rowEmail = rowValue(row, ['邮箱', 'email']);
    const rowPhone = rowValue(row, ['联系方式', 'phone']);
    if (rowEmail || rowPhone || row.contact_url || row.website) {
      const contactValue = rowEmail || row.contact_url || rowPhone || row.website;
      const contactType = rowEmail ? 'generic_email' : row.contact_url ? 'contact_form' : rowPhone ? 'phone' : 'website';
      const contactId = stableId('con', `${employer.employer_id}-${contactType}-${contactValue}`);
      if (!state.contacts.some((item) => item.contact_id === contactId)) {
        state.contacts.push({
          contact_id: contactId,
          employer_id: employer.employer_id,
          contact_type: contactType,
          value: contactValue,
          role: contactType,
          source_url: row.website || row.contact_url || '',
          source_context: 'seed import',
          confidence: contactType === 'generic_email' ? 72 : 58,
          is_generic_contact: true,
          is_personal_contact: false,
          do_not_contact: false,
          last_verified: todayIso(),
          phone: rowPhone,
          email: rowEmail
        });
      }
    }

    const jobTitle = rowValue(row, ['招聘岗位（已确认符合CSOL清单要求）', '招聘岗位', 'job_title', 'occupation']);
    if (jobTitle) {
      const platform = rowValue(row, ['获取招聘信息平台', 'source_name']) || 'Manual import';
      const jobId = stableId('job', `${employer.employer_id}-${jobTitle}-${platform}`);
      if (!state.job_ads.some((item) => item.job_id === jobId)) {
        state.job_ads.push({
          job_id: jobId,
          source_name: platform,
          source_url: row.source_url || '',
          source_type: 'import',
          employer_id: employer.employer_id,
          title: jobTitle,
          description_text: `${jobTitle} ${rowValue(row, ['备注', 'notes'])}`,
          location_text: region || suburb,
          postcode,
          salary_text: '',
          posted_date: rowValue(row, ['搜索日期', 'posted_date']) || todayIso(),
          seen_date: rowValue(row, ['搜索日期', 'seen_date']) || todayIso(),
          raw_snippet: rowValue(row, ['备注', 'notes']),
          evidence_hash: stableId('ev', jobId),
          anzsco_code: rowValue(row, ['ANZSCO', 'anzsco']),
          progress: rowValue(row, ['目前进展', 'progress']) || '未联系',
          notes: rowValue(row, ['备注', 'notes']),
          ad_screenshot: rowValue(row, ['广告截图', 'ad_screenshot'])
        });
      }
    }

    return employer;
  }

  function discoverSeedJobs(state) {
    let created = 0;
    for (const employer of state.employers) {
      if (!employer.known_occupation) continue;
      const exists = state.job_ads.some((job) => job.employer_id === employer.employer_id);
      if (exists) continue;
      const location = state.employer_locations.find((item) => item.employer_id === employer.employer_id);
      const jobId = stableId('job', `${employer.employer_id}-${employer.known_occupation}`);
      state.job_ads.push({
        job_id: jobId,
        source_name: 'Manual seed',
        source_url: employer.contact_url || employer.website || '',
        source_type: 'manual_review',
        employer_id: employer.employer_id,
        title: employer.known_occupation,
        description_text: `${employer.known_occupation} candidate target from seed list. Manual review required before outreach.`,
        location_text: location ? [location.suburb, location.state].filter(Boolean).join(' ') : '',
        postcode: location?.postcode || '',
        salary_text: '',
        posted_date: todayIso(),
        seen_date: todayIso(),
        raw_snippet: 'Seed occupation target. Needs current vacancy evidence.',
        evidence_hash: stableId('ev', jobId)
      });
      created += 1;
    }
    return created;
  }

  function enrichCompanies(state) {
    let changed = 0;
    for (const employer of state.employers) {
      employer.source_last_checked = todayIso();
      if (!employer.contact_url && employer.website) {
        employer.contact_url = `${employer.website.replace(/\/$/, '')}/careers`;
        changed += 1;
      }
    }
    return changed;
  }

  async function runAction(action, payload = {}) {
    let state = readState();
    let message = '';

    if (action === 'daily-run') {
      const region = payload.region || state.meta.search_region || 'NSW';
      const sources = payload.sources || state.meta.search_sources || SOURCE_PLATFORMS;
      const generated = createPlatformCandidates(state, region, sources);
      const discovered = discoverSeedJobs(state);
      const enriched = enrichCompanies(state);
      state = scoreState(state);
      state.meta.last_daily_run_at = todayIso();
      message = `今日雷达完成：${region} / ${sources.join(', ')}，新增 ${generated} 条平台候选，${discovered} 条种子任务，当前共 ${state.lead_scores.length} 条。`;
      addActivity(state, 'daily_run', message);
    } else if (action === 'sync-seeds') {
      for (const employer of state.employers) {
        employer.normalized_name = normalizeName(employer.legal_name);
        employer.source_last_checked = todayIso();
      }
      message = `Sponsor seeds normalized: ${state.employers.length} employers checked.`;
      addActivity(state, 'sync', message);
    } else if (action === 'discover-jobs') {
      const discovered = discoverSeedJobs(state);
      message = `Job discovery finished: ${discovered} seed-based review jobs created.`;
      addActivity(state, 'job_discovery', message);
    } else if (action === 'enrich-companies') {
      const enriched = enrichCompanies(state);
      message = `Company enrichment finished: ${enriched} contact URLs filled.`;
      addActivity(state, 'enrichment', message);
    } else if (action === 'score-leads') {
      state = scoreState(state);
      message = `Lead scoring refreshed: ${state.lead_scores.length} leads ranked.`;
      addActivity(state, 'scoring', message);
    } else if (action === 'import-seeds') {
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      let imported = 0;
      for (const row of rows) {
        if (upsertEmployer(state, row)) imported += 1;
      }
      state = scoreState(state);
      message = `Seed import finished: ${imported} employers upserted.`;
      addActivity(state, 'import', message);
    } else if (action === 'review-lead') {
      const lead = state.lead_scores.find((item) => item.lead_id === payload.lead_id);
      if (!lead) throw new Error('Lead not found');
      lead.review_status = payload.review_status || lead.review_status;
      lead.next_action = payload.next_action || lead.next_action;
      lead.reviewer_notes = payload.reviewer_notes ?? lead.reviewer_notes;
      if (payload.review_status === 'contacted') lead.last_contacted = todayIso();
      message = `Lead ${lead.lead_id} marked ${lead.review_status}.`;
      addActivity(state, 'review', message);
    } else if (action === 'reset-demo') {
      state = createInitialState();
      message = 'Demo workspace reset.';
      addActivity(state, 'system', message);
    } else {
      throw new Error(`Unknown action: ${action}`);
    }

    state = saveState(state);
    return { state, message };
  }

  function escapeCell(value) {
    const text = value == null ? '' : String(value);
    if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
    return text;
  }

  function exportLeadsCsv(state) {
    const headers = [
      ['公司名称', (row) => row.employer.legal_name],
      ['搜索日期', (row) => (row.job.seen_date || '').slice(0, 10)],
      ['所在地区', (row) => row.location.state || row.location.suburb],
      ['公司地址', (row) => row.location.address_raw],
      ['ANZSCO', (row) => row.job.anzsco_code || row.lead.occupation_match?.anzsco_code || ''],
      ['招聘岗位（已确认符合CSOL清单要求）', (row) => row.job.title],
      ['获取招聘信息平台', (row) => row.job.source_name],
      ['目前进展', (row) => row.lead.review_status === 'new' ? (row.job.progress || '未联系') : row.lead.review_status],
      ['备注', (row) => row.job.notes || row.job.raw_snippet || ''],
      ['联系方式', (row) => row.bestContact.phone || row.employer.main_phone || ''],
      ['邮箱', (row) => row.bestContact.email || row.employer.main_email || row.bestContact.value || ''],
      ['广告截图', (row) => row.job.ad_screenshot || ''],
      ['复核链接', (row) => row.job.source_url]
    ];

    const rows = state.lead_scores.map((lead) => {
      const employer = state.employers.find((item) => item.employer_id === lead.employer_id) || {};
      const job = state.job_ads.find((item) => item.job_id === lead.latest_job_id) || {};
      const location = state.employer_locations.find((item) => item.employer_id === lead.employer_id) || {};
      const bestContact = state.contacts
        .filter((item) => item.employer_id === lead.employer_id && !item.do_not_contact)
        .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0] || {};
      return { lead, employer, job, location, bestContact };
    });

    const output = [headers.map(([label]) => escapeCell(label)).join(',')];
    for (const row of rows) {
      output.push(headers.map(([, value]) => escapeCell(value(row))).join(','));
    }
    return `${output.join('\n')}\n`;
  }

  window.RadarEngine = {
    readState,
    runAction,
    exportLeadsCsv,
    saveState,
    createInitialState
  };
}());
