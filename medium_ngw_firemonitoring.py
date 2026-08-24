import hashlib
import io
import os
from datetime import datetime, timedelta, timezone

import pandas as pd
import requests
from requests.auth import HTTPBasicAuth
from shapely import Point, unary_union
from shapely.geometry import shape

# SET UP THE CONFIGURATION
NGW_URL = ''
NGW_USER = ''
NGW_PASSWORD = ''
FIRMS_MAP_KEY = ''
AOI_LAYER_ID = 0
FIRE_LAYER_ID = 0

FIRMS_SOURCES = (
    "VIIRS_NOAA20_NRT",
    "VIIRS_NOAA21_NRT",
)

session = requests.Session()
session.auth = HTTPBasicAuth(NGW_USER, NGW_PASSWORD)
session.headers.update({"Accept": "*/*"})

def ngw_request(method, path, **kwargs):
    response = session.request(
        method,
        f"{NGW_URL}{path}",
        timeout=60,
        **kwargs,
    )
    response.raise_for_status()
    return response

def get_aoi():
    response = ngw_request(
        "GET",
        f"/api/resource/{AOI_LAYER_ID}/feature/",
        params={
            "srs": 4326,
            "geom_format": "geojson"
        },
    )

    features = response.json()

    if not features:
        raise RuntimeError("Area of interest layer is empty")

    geometries = [
        shape(feature["geom"]) for feature in features if feature.get("geom")
    ]

    if not geometries:
        raise RuntimeError("Area of interest contains no geometries")

    return unary_union(geometries)

def filter_by_aoi(df, aoi): 
    if df.empty:
        return df 

    mask = [
        aoi.covers(Point(lon, lat))
        for lon, lat in zip(df["longitude"], df["latitude"]) 
    ]
    return df[mask].copy()

def fetch_firms(source, bbox):
    print(source)
    url = (
        "https://firms.modaps.eosdis.nasa.gov"
        f"/api/area/csv/{FIRMS_MAP_KEY}/{source}/{bbox}/5/2026-08-14"
    )

    response = requests.get(url, timeout=60)
    response.raise_for_status()

    df = pd.read_csv(io.StringIO(response.text))
    
    if df.empty:
        return df

    acq_time = df["acq_time"].astype(str).str.zfill(4)

    df["acq_datetime"] = pd.to_datetime(
        df["acq_date"].astype(str) + " " + acq_time.str[:2] + ":" + acq_time.str[2:],
        utc=True,
    )

    return df
    
def make_detection_id(row):
    value = (
        f"{row['satellite']}|"
        f"{row['acq_datetime'].isoformat()}|"
        f"{row['latitude']:.5f}|"
        f"{row['longitude']:.5f}"
    )
    return hashlib.sha1(value.encode()).hexdigest()

    
def get_existing_detection_ids():
    response = ngw_request(
        "GET",
        f"/api/resource/{FIRE_LAYER_ID}/feature/",
        params={
            "fields": "detection_id",
            "geom": "no"
        },
      )
    return {
        feature["fields"]["detection_id"]
        for feature in response.json()
        if feature["fields"].get("detection_id")
      }

def ngw_datetime(value):
    dt = value.to_pydatetime()
    return {
        "year": dt.year,
        "month": dt.month,
        "day": dt.day,
        "hour": dt.hour,
        "minute": dt.minute,
        "second": dt.second,
    }

def row_to_feature(row):
    return {
        "geom": (
            f"POINT ({row['longitude']} {row['latitude']})"
        ),
        "fields": {
            "detection_id": row["detection_id"],
            "acq_datetime": ngw_datetime(
                row["acq_datetime"]
            ),
            "satellite": str(row["satellite"]),
            "confidence": str(row["confidence"]),
            "frp": float(row["frp"]),
            "daynight": str(row["daynight"])
        },
    }
    
def upload_new_fires(df):
    if df.empty:
        return 0
    features = [
        row_to_feature(row)
        for _, row in df.iterrows()
    ]
    ngw_request(
        "PATCH",
        f"/api/resource/{FIRE_LAYER_ID}/feature/",
        params={"srs": 4326},
        json=features,
    )
    return len(features)
    
def main():
    aoi = get_aoi()
    west, south, east, north = aoi.bounds
    bbox = f"{west},{south},{east},{north}"
    frames = [
        fetch_firms(source, bbox)
        for source in FIRMS_SOURCES
    ]
    
    frames = [
        frame
        for frame in frames 
        if not frame.empty
    ]
    
    if frames:
        fires = pd.concat(
            frames,
            ignore_index=True,
        )
        fires = filter_by_aoi(fires, aoi)
        if fires.empty:
            added = 0
        else:
            fires["detection_id"] = fires.apply(
                make_detection_id,
                axis=1,
            )
            existing_ids = get_existing_detection_ids()
            new_fires = fires[
                ~fires["detection_id"].isin(existing_ids)
            ]
            added = upload_new_fires(new_fires)
    else:
        added = 0
    
    print(
        f"Added {added} new fire detections; "
    )
    
if __name__ == "__main__":
    main()
