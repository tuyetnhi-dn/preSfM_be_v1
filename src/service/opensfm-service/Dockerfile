FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV OPENSFM_ROOT=/opt/OpenSfM
ENV OPENSFM_BIN=/opt/OpenSfM/bin/opensfm
ENV OPENSFM_WORKSPACE=/workspace/opensfm-runs

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    build-essential \
    cmake \
    python3 \
    python3-dev \
    python3-pip \
    python3-venv \
    python-is-python3 \
    libeigen3-dev \
    libopencv-dev \
    libceres-dev \
    libgoogle-glog-dev \
    libsuitesparse-dev \
    libjpeg-dev \
    zlib1g-dev \
    libomp-dev \
    libboost-all-dev \
    libgl1 \
    libglib2.0-0 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

RUN python3 -m venv /opt/venv

ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /opt

RUN git clone --recursive https://github.com/mapillary/OpenSfM.git

WORKDIR /opt/OpenSfM

RUN pip install --no-cache-dir --upgrade pip setuptools wheel \
    && pip install --no-cache-dir -e .

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8005

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8005"]