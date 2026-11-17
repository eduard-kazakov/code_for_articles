import NgwMap from '@nextgis/ngw-leaflet';
import Chart from 'chart.js/auto';
import './style.css';

const NGW_URL = 'https://ekazakov.nextgis.com';
const WEBMAP_ID = 4778;
const CITIES_LAYER_ID = 4770;

const populationBins = [
  0,
  10_000,
  100_000,
  1_000_000,
  10_000_000,
  Infinity
];

const populationLabels = [
  '<10K',
  '10K-100K',
  '100K-1M',
  '1M-10M',
  '>10M'
];

const statusElement = document.getElementById(
  'statistics-status'
);

// --------------------------------------------------
// 1. Initialize NextGIS Web Map
// --------------------------------------------------

const ngwMap = new NgwMap({
  target: 'map',
  baseUrl: NGW_URL,
  resources: [
    {
      resource: WEBMAP_ID,
      fit: true
    }
  ]
});

await ngwMap.onLoad();


// --------------------------------------------------
// 2. Display the existing NextGIS Web legend
// --------------------------------------------------

async function renderLegend() {
  const container = document.getElementById('legend');
  container.replaceChildren();

  try {
    const legends = await ngwMap.getLegend();
    // Get the original layer names from the NGW Web Map
    const response = await fetch(
      `${NGW_URL}/api/resource/${WEBMAP_ID}`
    );

    if (!response.ok) {
      throw new Error('Failed to retrieve Web Map configuration');
    }

    const webmapResource = await response.json();

    const webmapLayers = webmapResource.webmap.root_item.children
      .filter(item => item.item_type === 'layer');

    for (const [index, layer] of legends.entries()) {
      const group = document.createElement('div');
      group.className = 'legend-layer';

      // Use the NGW style resource ID, not the SDK layer ID.
      const heading = document.createElement('strong');

      heading.textContent =
        webmapLayers[index]?.display_name ??
        `Layer ${layer.layerId}`;

      group.append(heading);

      // Retrieve legend symbols from NGW if not loaded yet.
      const symbols = layer.legend?.length
        ? layer.legend
        : (await layer.create?.()) ?? [];

      for (const symbol of symbols) {
        const row = document.createElement('div');
        row.className = 'legend-symbol';

        // Render the original NGW legend symbol
        if (symbol.icon?.data) {
          const icon = document.createElement('img');

          icon.src = `data:image/${symbol.icon.format};base64,${symbol.icon.data}`;
          icon.alt = symbol.display_name || '';

          row.append(icon);
        }

        // Render the symbol label
        const label = document.createElement('span');
        label.textContent = symbol.display_name || '';

        row.append(label);
        group.append(row);
      }

      container.append(group);
    }

  } catch (error) {
    console.error('Failed to load map legend:', error);
    container.textContent = 'Could not load legend.';
  }
}


await renderLegend();


// --------------------------------------------------
// 3. Initialize population histogram
// --------------------------------------------------

const chart = new Chart(
  document.getElementById('population-chart'),
  {
    type: 'bar',

    data: {
      labels: populationLabels,

      datasets: [
        {
          label: 'Populated places',
          data: populationLabels.map(() => 0),
          backgroundColor: '#377eb8',
          borderRadius: 4
        }
      ]
    },

    options: {
      responsive: true,
      maintainAspectRatio: false,

      plugins: {
        legend: {
          display: false
        },

        tooltip: {
          callbacks: {
            label: (context) =>
              `${context.parsed.y} populated places`
          }
        }
      },

      scales: {
        x: {
          title: {
            display: true,
            text: 'Population'
          }
        },

        y: {
          beginAtZero: true,

          ticks: {
            precision: 0
          },

          title: {
            display: true,
            text: 'Number of populated places'
          }
        }
      }
    }
  }
);


// --------------------------------------------------
// 4. Calculate population histogram
// --------------------------------------------------

function calculateHistogram(populations) {
  const counts = populationLabels.map(() => 0);

  for (const population of populations) {
    for (let i = 0; i < counts.length; i++) {
      if (
        population >= populationBins[i] &&
        population < populationBins[i + 1]
      ) {
        counts[i]++;
        break;
      }
    }
  }

  return counts;
}


function updateHistogram(populations) {
  chart.data.datasets[0].data =
    calculateHistogram(populations);

  chart.update();

  statusElement.textContent =
    `${populations.length.toLocaleString()} populated places in view`;
}


// --------------------------------------------------
// 5. Fetch populations within current map bounds
// --------------------------------------------------

async function getVisiblePopulations() {
  const bounds = ngwMap.getBounds();

  if (!bounds) {
    return [];
  }

  const populations = [];
  const limit = 1000;

  for (let offset = 0; ; offset += limit) {
    const result = await ngwMap.fetchNgwLayerFeatures({
      resourceId: CITIES_LAYER_ID,
      intersects: bounds,
      fields: ['POP_MAX'],
      geom: false,
      limit,
      offset
    });

    const features = result.features ?? [];

    for (const feature of features) {
      const population = Number(
        feature.properties?.POP_MAX
      );

      if (
        Number.isFinite(population) &&
        population > 0
      ) {
        populations.push(population);
      }
    }

    if (features.length < limit) {
      break;
    }
  }

  return populations;
}


// --------------------------------------------------
// 6. Refresh statistics when map extent changes
// --------------------------------------------------

let requestVersion = 0;

async function refreshStatistics() {
  const version = ++requestVersion;

  statusElement.textContent = 'Updating statistics...';

  try {
    const populations = await getVisiblePopulations();

    // Ignore outdated responses
    if (version !== requestVersion) {
      return;
    }

    updateHistogram(populations);

  } catch (error) {
    if (version !== requestVersion) {
      return;
    }

    console.error(
      'Could not retrieve population statistics:',
      error
    );

    statusElement.textContent =
      'Could not load population statistics.';
  }
}


// --------------------------------------------------
// 7. Listen for map navigation
// --------------------------------------------------

const leafletMap = ngwMap.mapAdapter.map;

leafletMap.on('moveend', refreshStatistics);


// --------------------------------------------------
// 8. Load initial statistics
// --------------------------------------------------

await refreshStatistics();