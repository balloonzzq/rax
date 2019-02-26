import { PolymerElement, html } from '@polymer/polymer';
import getFileSchemaPrefix from '../../shared/getFileSchemaPrefix';

const UNSENT = 0;
const LOADING = 1;
const DONE = 2;
const IS_HTTP_REG = /^(https?:)?\/{2}/;
const IS_BASE64_DATA_REG = /^data:/;
const POSITIONS = [
  'top',
  'bottom',
  'center',
  'left',
  'right',
  'top left',
  'top right',
  'bottom left',
  'bottom right',
];
/**
 * Local files:
 *   eg: /foo/bar.png
 * Network files:
 *   eg: https://xxx
 *       http://xxxx
 *       //xxxx
 */
const IS_ABS_REG = /^\/[^/]/;

function handleIntersect(entries) {
  entries.forEach(entry => {
    if (entry.isIntersecting === true) {
      const cb = ImageElement._intersectListeners.get(entry.target);
      if (cb !== undefined) cb(entry);
    }
  });
}

export default class ImageElement extends PolymerElement {
  static get is() {
    return 'a-image';
  }

  /**
   * Methods used to determine when this element is in the visible viewport
   */
  static _intersectListeners = new Map();

  static _observer = new IntersectionObserver(handleIntersect, {
    root: null,
    rootMargin: '0px',
    threshold: 0,
  });

  static addIntersectListener(element, intersectCallback) {
    ImageElement._intersectListeners.set(element, intersectCallback);
    ImageElement._observer.observe(element);
  }

  static removeIntersectListener(element) {
    if (element) ImageElement._observer.unobserve(element);
  }

  static get properties() {
    return {
      src: {
        type: String,
        value: '',
        reflectToAttribute: true,
        observer: '_observeSrc'
      },
      mode: {
        type: String,
        value: 'scaleToFill',
        reflectToAttribute: true,
        observer: '_observeMode',
      },
      lazyload: {
        type: Boolean,
        value: false,
        computed: '_computeLazyLoad(lazyload)',
      },
    };
  }

  isReady = false;

  ready() {
    super.ready();
    this.isReady = true;
    this._init();
  }


  _observeSrc(newVal) {
    // If the src is changed then we need to reset and start again
    this._reset();
    if (this.isReady) {
      this._init();
    }
  }

  _observeMode(newVal, oldVal) {
    if (oldVal === undefined) return;

    const container = this.$.container;
    const containerStyle = container.style;

    if (oldVal === 'widthFix') {
      this.style.height = this.initialHeight;
    }

    if (POSITIONS.indexOf(newVal) > -1) {
      containerStyle.backgroundSize = 'auto';
      containerStyle.backgroundPosition = `${newVal}`;
    } else {
      switch (newVal) {
        case 'scaleToFill':
          containerStyle.backgroundSize = '100% 100%';
          containerStyle.backgroundPosition = '0% 0%';
          break;
        case 'aspectFit':
          containerStyle.backgroundSize = 'contain';
          containerStyle.backgroundPosition = 'center center';
          break;
        case 'aspectFill':
          containerStyle.backgroundSize = 'cover';
          containerStyle.backgroundPosition = 'center center';
          break;
        case 'widthFix':
          if (this.state < DONE) {
            this._needAdaptHeight = true;
          } else {
            this._adaptHeight();
          }
          break;
      }
    }
  }

  /**
   * Compatible with lazyload and lazyLoad
   *   for previous versions, we use `lazyload` prop,
   *   but to compatible with `lazy-load` or `lazyLoad`
   *   in other mini-program standard image components.
   */
  _computeLazyLoad(lazyload) {
    return Boolean(lazyload || this.lazyLoad);
  }

  _init() {
    if (!this.src) return;

    if (this.lazyload) {
      // Figure out if this image is within view
      ImageElement.addIntersectListener(this, () => {
        this._load();
        ImageElement.removeIntersectListener(this);
      });
    } else {
      // Load after next frame
      this._load();
    }

    this._inited = true;
  }

  /**
   * Method which renders the DOM elements and displays any preview image
   * @private
   */
  _render() {
    if (this._rendered === true) return;
    this._observeMode(this.mode, '');
    const containerStyle = this.$.container.style;
    containerStyle.backgroundImage = `url(${this._getSourceUrl()})`;
    // Flag as rendered
    this._rendered = true;
  }

  _getSourceUrl() {
    const fileSchemaPrefix = getFileSchemaPrefix() || '';
    if (IS_ABS_REG.test(this.src)) {
      return fileSchemaPrefix + this.src;
    } else if (IS_HTTP_REG.test(this.src) || IS_BASE64_DATA_REG.test(this.src)) {
      return this.src;
    } else {
      return fileSchemaPrefix + '/' + this.src;
    }
  }

  /**
   * Method which displays the image once ready to be displayed
   * @private
   */
  _load() {
    this.state = LOADING;
    const image = this.image = new Image();
    // Decode the image asynchronously to reduce delay in presenting other content.
    image.decoding = 'async';

    image.onload = (evt) => {
      this.state = DONE;

      if (this._needAdaptHeight) {
        this._adaptHeight();
      }

      // Dispatch custom load event
      const customEvent = new CustomEvent('load', {
        bubbles: false,
        composed: true,
        detail: {
          width: `${image.width}px`,
          height: `${image.height}px`,
        },
      });
      this.dispatchEvent(customEvent);
    };

    image.onerror = (evt) => {
      this.state = DONE;
      const customEvent = new CustomEvent('error', {
        bubbles: false,
        composed: true,
        detail: {
          errMsg: `Load ${this.src} error`,
        },
      });
      this.dispatchEvent(customEvent);
    };
    image.src = this._getSourceUrl();
    this._render();
  }

  /**
   * Get and adjust container's height
   * to 100% cover the image's real rect
   * @private
   */
  _adaptHeight() {
    this._needAdaptHeight = false;

    const containerStyle = this.$.container.style;
    const { width: realWidth, height: realHeight } = this.image;
    const hostWidth = this.clientWidth;
    const hostHeight = hostWidth * realHeight / realWidth;

    this.style.height = hostHeight + 'px';
    containerStyle.backgroundSize = 'contain';
  }

  /**
   * Reset all private values
   * @private
   */
  _reset() {
    this._inited = false;
    this._rendered = false;
    this.state = UNSENT;
  }

  static get template() {
    return html`
      <style>
        :host {
          position: relative;
          overflow: hidden;
          display: inline-block;
          outline: none;
          /* Default width/height is 300px/225px */
          width: 300px;
          height: 225px;
          line-height: 0;
        }
  
        #container {
          width: 100%;
          height: 100%;
          background-repeat: no-repeat;
        }
      </style>
      <div id="container"></div>
    `;
  }
}

customElements.define(ImageElement.is, ImageElement);
